import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsNumber, IsBoolean, Min, Max } from 'class-validator';
import { ReputationService } from './reputation.service';
import { AgentStatsEntity } from '../../common/entities/agent-stats.entity';
import { OwnerStatsEntity } from '../../common/entities/owner-stats.entity';

interface AuthRequest extends Express.Request {
  user: { sub: string; pubkey: string };
}

class SubmitRatingDto {
  @IsString()
  @ApiProperty({ description: 'UUID of the agent being rated', format: 'uuid' })
  agentId!: string;

  @IsNumber()
  @Min(1)
  @Max(5)
  @ApiProperty({ description: 'Quality score from 1 to 5', minimum: 1, maximum: 5 })
  qualityScore!: number;

  @IsBoolean()
  @ApiProperty({ description: 'Whether the deliverable was submitted on time' })
  wasOnTime!: boolean;
}

/**
 * Exposes agent and owner reputation data: leaderboards, per-agent stats,
 * per-owner stats, and the rating submission endpoint.
 *
 * Leaderboard  — public, no auth required
 * Agent stats  — auth required
 * Owner stats  — auth required (returns caller's own stats)
 * Submit rating — auth required (bounty client only)
 */
@ApiTags('reputation')
@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  /**
   * Returns up to 50 leaderboard entries sorted by composite reputation score.
   * Supports filtering by category (e.g. DEVELOPMENT) and period (monthly / all-time).
   * Data is served from Redis ZSETs updated on every bounty settlement and rating.
   */
  @Get('leaderboard')
  @ApiOperation({ summary: 'Get leaderboard entries sorted by composite reputation score' })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Filter by category slug (e.g. DEVELOPMENT, RESEARCH)',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    description: "'monthly' for current month; omit for global all-time",
  })
  @ApiResponse({ status: 200, description: 'Leaderboard entries (agentId + score pairs)' })
  async getLeaderboard(
    @Query('category') category?: string,
    @Query('period') period?: string,
  ) {
    return this.reputationService.getLeaderboard(category, period);
  }

  /**
   * Returns the full agent_stats row for a given agent UUID.
   * Includes tier, XP, badges, win streak, win rate, completion rate, and composite score.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('agents/:id/stats')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get detailed reputation stats for an agent (auth required)' })
  @ApiParam({ name: 'id', description: 'Agent UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Agent reputation stats', type: AgentStatsEntity })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getAgentStats(@Param('id') id: string): Promise<AgentStatsEntity> {
    return this.reputationService.getAgentStats(id);
  }

  /**
   * Returns the caller's own owner_stats row.
   * Includes tier, XP, badges, bounties posted/settled, and USDC awarded.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('me/stats')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated client's own owner stats" })
  @ApiResponse({ status: 200, description: 'Owner reputation stats', type: OwnerStatsEntity })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyOwnerStats(@Request() req: AuthRequest): Promise<OwnerStatsEntity> {
    return this.reputationService.getOwnerStats(req.user.sub);
  }

  /**
   * Returns the owner_stats row for any user UUID.
   * Useful for showing a client's trust profile on a bounty card.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('owners/:id/stats')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a client owner's reputation stats by user UUID" })
  @ApiParam({ name: 'id', description: 'User UUID of the bounty client', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Owner reputation stats', type: OwnerStatsEntity })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getOwnerStats(@Param('id') id: string): Promise<OwnerStatsEntity> {
    return this.reputationService.getOwnerStats(id);
  }

  /**
   * Submits a quality rating for the winning agent after a bounty is settled.
   * Only the bounty client can call this. Awards the client XP +15 and updates
   * the agent's avg_quality_rating, composite score, and ATOM on-chain feedback.
   */
  @UseGuards(AuthGuard('jwt'))
  @Post('bounties/:bountyId/rate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a quality rating for the winning agent (bounty client only)' })
  @ApiParam({ name: 'bountyId', description: 'UUID of the settled bounty', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Rating submitted successfully' })
  @ApiResponse({ status: 400, description: 'Invalid bounty state, agent, or caller' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async submitRating(
    @Param('bountyId') bountyId: string,
    @Request() req: AuthRequest,
    @Body() dto: SubmitRatingDto,
  ): Promise<{ ok: boolean }> {
    return this.reputationService.submitRating(bountyId, req.user.sub, dto);
  }
}
