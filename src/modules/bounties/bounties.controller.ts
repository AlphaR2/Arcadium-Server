import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { BountiesService } from './bounties.service';
import { BountiesRegistrationService } from './bounties-registration.service';
import { BountiesReviewService } from './bounties-review.service';
import { CreateBountyDto } from './dto/create-bounty.dto';
import { RegisterAgentDto, SelectWinnerDto } from './dto/register-agent.dto';
import { RateBountyDto } from './dto/rate-bounty.dto';
import { ReputationService } from '../reputation/reputation.service';
import { BountyEntity } from '../../common/entities/bounty.entity';

/** Express request object extended with the JWT payload set by JwtAuthGuard. */
interface AuthRequest extends Express.Request {
  user: JwtPayload;
}

/**
 * Manages the full bounty lifecycle: creation, agent registration, winner selection.
 * All endpoints require a valid JWT (Bearer token).
 */
@ApiTags('bounties')
@ApiBearerAuth()
@Controller('bounties')
@UseGuards(JwtAuthGuard)
export class BountiesController {
  constructor(
    private readonly bountiesService: BountiesService,
    private readonly registrationService: BountiesRegistrationService,
    private readonly reviewService: BountiesReviewService,
    private readonly reputationService: ReputationService,
  ) {}

  /**
   * Creates a new bounty record and returns an unsigned create_escrow transaction.
   * The client must sign and broadcast the transaction via Phantom to fund the escrow
   * before the bounty becomes visible to agents.
   */
  @Post()
  @ApiOperation({ summary: 'Create a bounty and receive unsigned create_escrow tx' })
  @ApiResponse({ status: 201, description: 'Bounty created', schema: { properties: { bountyId: { type: 'string' }, tx: { type: 'string' } } } })
  create(@Request() req: AuthRequest, @Body() dto: CreateBountyDto) {
    return this.bountiesService.createBounty(dto, req.user.pubkey, req.user.sub);
  }

  /**
   * Returns all bounties dispatched to the caller's agents that are waiting
   * to be picked up (dispatch_state='queued', no submission yet).
   *
   * Intended for polling agents — call on a schedule (e.g. every 30 min),
   * pick up open work, submit via POST deliverables endpoint.
   * Only returns work for agents owned by the authenticated user.
   */
  @Get('dispatched')
  @ApiOperation({ summary: 'Poll for bounties dispatched to your agents (polling mode)' })
  @ApiResponse({
    status: 200,
    description: 'Queued dispatches waiting to be picked up by polling agents',
    schema: {
      type: 'array',
      items: {
        properties: {
          registration_id: { type: 'string', format: 'uuid' },
          agent_id: { type: 'string', format: 'uuid' },
          bounty: { type: 'object' },
        },
      },
    },
  })
  getDispatched(@Request() req: AuthRequest) {
    return this.registrationService.getDispatched(req.user.sub);
  }

  /**
   * Returns a filtered list of bounties.
   * Defaults to state=open when no state filter is provided.
   */
  @Get()
  @ApiOperation({ summary: 'Browse bounties with optional filters' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category (e.g. DEVELOPMENT)' })
  @ApiQuery({ name: 'state', required: false, description: 'Bounty state (defaults to open)' })
  @ApiQuery({ name: 'sort', required: false, description: 'Sort order (reserved for future use)' })
  @ApiResponse({ status: 200, description: 'List of matching bounties', type: [BountyEntity] })
  browse(
    @Query('category') category?: string,
    @Query('state') state?: string,
    @Query('sort') sort?: string,
  ) {
    return this.bountiesService.browse({ category, state, sort });
  }

  /** Returns the full details of a single bounty by UUID. */
  @Get(':id')
  @ApiOperation({ summary: 'Get bounty details by UUID' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Bounty details', type: BountyEntity })
  @ApiResponse({ status: 404, description: 'Bounty not found' })
  findOne(@Param('id') id: string) {
    return this.bountiesService.findById(id);
  }

  /**
   * Registers an agent for a bounty.
   * Creates a bounty_registration record and enqueues a dispatch job that will
   * call the agent's webhook with the bounty details.
   */
  @Post(':id/register')
  @ApiOperation({ summary: "Register one of the caller's agents for a bounty" })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Agent registered, dispatch enqueued' })
  registerAgent(
    @Request() req: AuthRequest,
    @Param('id') bountyId: string,
    @Body() dto: RegisterAgentDto,
  ) {
    return this.registrationService.registerAgent(
      bountyId,
      dto.agentId,
      req.user.sub,
    );
  }

  /**
   * Removes an agent from a bounty before the submission deadline.
   * Deletes the bounty_registration record.
   */
  @Delete(':id/register/:agentId')
  @ApiOperation({ summary: 'De-register an agent from a bounty' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiParam({ name: 'agentId', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Agent de-registered' })
  deregisterAgent(
    @Param('id') bountyId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.registrationService.deregisterAgent(bountyId, agentId);
  }

  /**
   * Re-enqueues the dispatch job for a registration whose previous attempts failed.
   * Use when the agent's webhook was temporarily unavailable.
   */
  @Post(':id/retry-dispatch/:regId')
  @ApiOperation({ summary: 'Retry the dispatch webhook call for a failed registration' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiParam({ name: 'regId', description: 'Registration UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Dispatch job re-enqueued', schema: { properties: { queued: { type: 'boolean' } } } })
  retryDispatch(@Param('regId') regId: string) {
    return this.registrationService.retryDispatch(regId);
  }

  /**
   * Returns all deliverables submitted for a bounty.
   * Used by the client to review agent work before selecting a winner.
   */
  @Get(':id/submissions')
  @ApiOperation({ summary: 'List all deliverables submitted for a bounty' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'List of deliverables with registration details' })
  getSubmissions(@Param('id') bountyId: string) {
    return this.registrationService.getSubmissions(bountyId);
  }

  /**
   * Selects a winner and triggers escrow settlement.
   * Server-side:
   *   1. Calls update_escrow (authority-signed) to mark fulfilled + set agentOwner
   *   2. Returns an unsigned settle_escrow tx for the client to sign via Phantom
   *
   * Bug fix: passes req.user.sub (clientId) so the service can verify the caller owns the bounty.
   */
  @Post(':id/winner')
  @ApiOperation({ summary: 'Select winner and receive unsigned settle_escrow tx' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Winner set, unsigned settle tx returned', schema: { properties: { tx: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Caller is not the bounty client' })
  selectWinner(
    @Request() req: AuthRequest,
    @Param('id') bountyId: string,
    @Body() dto: SelectWinnerDto,
  ) {
    /* req.user.pubkey = on-chain signer; req.user.sub = DB client UUID for ownership check */
    return this.reviewService.selectWinner(
      bountyId,
      dto.winnerAgentId,
      req.user.pubkey,
      req.user.sub,
    );
  }

  /**
   * Returns an unsigned settle_escrow refund tx for the client to sign.
   * Only callable when the bounty is in awaiting_refund state.
   * update_escrow(UnFulfilled) must already have been authority-signed
   * (triggered by the deadline cron when no winner was selected in time).
   */
  @Post(':id/claim-refund')
  @ApiOperation({ summary: 'Claim escrow refund — returns unsigned settle tx for Phantom' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Unsigned settle_escrow (refund) tx', schema: { properties: { tx: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Bounty is not in awaiting_refund state' })
  claimRefund(@Request() req: AuthRequest, @Param('id') bountyId: string) {
    return this.reviewService.claimRefund(bountyId, req.user.pubkey, req.user.sub);
  }

  /**
   * Submits a quality rating for the winning agent's deliverable.
   * Only callable by the bounty client after the bounty is settled.
   * Writes internal stats + ATOM Tag.starred feedback on-chain.
   */
  @Post(':id/rate')
  @ApiOperation({ summary: 'Rate the winning agent deliverable (0–100)' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Rating saved and reputation updated', schema: { properties: { ok: { type: 'boolean' } } } })
  @ApiResponse({ status: 400, description: 'Not the client, bounty not settled, or not the winner agent' })
  rate(
    @Request() req: AuthRequest,
    @Param('id') bountyId: string,
    @Body() dto: RateBountyDto,
  ) {
    return this.reputationService.submitRating(bountyId, req.user.sub, dto);
  }

  /**
   * Cancels a bounty.
   * TODO: implement on-chain escrow refund + state update.
   */
  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a bounty (not yet fully implemented)' })
  @ApiParam({ name: 'id', description: 'Bounty UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Bounty cancellation initiated' })
  cancel(@Param('id') bountyId: string) {
    return this.bountiesService.findById(bountyId); // TODO: implement on-chain cancel + refund
  }
}
