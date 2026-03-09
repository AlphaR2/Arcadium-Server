import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentEntity } from '../../common/entities/agent.entity';

/** Express request object extended with the JWT payload set by JwtAuthGuard. */
interface AuthRequest extends Express.Request {
  user: JwtPayload;
}

/**
 * Manages AI agent registration, discovery, and health monitoring.
 * All endpoints require a valid JWT (Bearer token).
 */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  /**
   * Registers a new agent on the marketplace.
   * Validates the webhook URL, builds OASF metadata, uploads to IPFS, and returns
   * an unsigned 8004 registerAgent transaction for the owner to sign via Phantom.
   */
  @Post()
  @ApiOperation({ summary: 'Register a new AI agent (returns unsigned 8004 tx)' })
  @ApiResponse({ status: 201, description: 'Agent created, unsigned tx returned' })
  create(@Request() req: AuthRequest, @Body() dto: CreateAgentDto) {
    return this.agentsService.registerAgent(dto, req.user.pubkey, req.user.sub);
  }

  /**
   * Browses all agents with optional category and health status filters.
   * Returns only confirmed (on-chain) agents unless filtered otherwise.
   */
  @Get()
  @ApiOperation({ summary: 'Browse agents with optional filters' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by bounty category (e.g. DEVELOPMENT)' })
  @ApiQuery({ name: 'health', required: false, description: 'Filter by health status (healthy, degraded, unhealthy)' })
  @ApiResponse({ status: 200, description: 'List of matching agents', type: [AgentEntity] })
  browse(
    @Query('category') category?: string,
    @Query('health') healthStatus?: string,
  ) {
    return this.agentsService.browse({ category, healthStatus });
  }

  /**
   * Returns all agents owned by the currently authenticated user.
   * Includes pending (unconfirmed) agents.
   */
  @Get('mine')
  @ApiOperation({ summary: "List the authenticated owner's agents" })
  @ApiResponse({ status: 200, description: "Owner's agents", type: [AgentEntity] })
  mine(@Request() req: AuthRequest) {
    return this.agentsService.findByOwner(req.user.sub);
  }

  /** Returns the full profile of a single agent by UUID. */
  @Get(':id')
  @ApiOperation({ summary: 'Get agent details by UUID' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Agent details', type: AgentEntity })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  findOne(@Param('id') id: string) {
    return this.agentsService.findById(id);
  }

  /** Updates mutable agent fields (name, description, webhook URL). */
  @Patch(':id')
  @ApiOperation({ summary: 'Update agent profile fields' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Updated agent', type: AgentEntity })
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agentsService.update(id, dto);
  }

  /**
   * Polls the 8004 SDK to confirm the agent's registration NFT has appeared on-chain.
   * Should be called after the owner broadcasts the registration transaction via Phantom.
   * Transitions the agent from `pending` to `healthy` health status once confirmed.
   */
  @Post(':id/confirm')
  @ApiOperation({ summary: 'Confirm on-chain 8004 registration after tx broadcast' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Confirmation result', schema: { properties: { confirmed: { type: 'boolean' }, assetPubkey: { type: 'string' } } } })
  confirmRegistration(@Request() req: AuthRequest, @Param('id') id: string) {
    /* Checks whether the 8004 NFT exists on-chain for the pending asset pubkey */
    return this.agentsService.confirmRegistration(id, req.user.sub);
  }

  /**
   * Triggers an immediate health check for the agent via 8004 sdk.isItAlive().
   * Useful for manual debugging; the scheduler also runs checks automatically.
   */
  @Post(':id/health-check')
  @ApiOperation({ summary: 'Trigger an immediate health check for an agent' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Health check result', schema: { properties: { status: { type: 'string' } } } })
  healthCheck(@Param('id') id: string) {
    return this.agentsService.triggerHealthCheck(id);
  }

  /**
   * Generates a new agent_token for an existing agent.
   * Use for agents created before the token system, or to rotate a compromised token.
   * The new token is returned once — store it immediately and share with your AI.
   */
  @Post(':id/rotate-token')
  @ApiOperation({ summary: 'Generate or rotate the agent submission token (agt_...)' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({
    status: 201,
    description: 'New agent token — returned once, store securely',
    schema: { properties: { agentToken: { type: 'string' } } },
  })
  @ApiResponse({ status: 400, description: 'Agent not found or caller is not the owner' })
  rotateToken(@Request() req: AuthRequest, @Param('id') id: string) {
    return this.agentsService.rotateAgentToken(id, req.user.sub);
  }
}
