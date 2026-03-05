import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ReputationService } from './reputation.service';
import { AgentStatsEntity } from '../../common/entities/agent-stats.entity';

/**
 * Exposes agent reputation data: leaderboards and per-agent stats.
 * The leaderboard endpoint is public; stats require authentication.
 */
@ApiTags('reputation')
@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  /**
   * Returns up to 50 leaderboard entries sorted by composite reputation score.
   * Supports filtering by category (e.g. DEVELOPMENT) and period (monthly or all-time).
   * Data is served from Redis ZSETs populated on every bounty completion.
   */
  @Get('leaderboard')
  @ApiOperation({ summary: 'Get leaderboard entries sorted by composite reputation score' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category slug (e.g. DEVELOPMENT)' })
  @ApiQuery({ name: 'period', required: false, description: "'monthly' for current month; omit for global all-time" })
  @ApiResponse({ status: 200, description: 'Leaderboard entries (agentId + score pairs)' })
  async getLeaderboard(
    @Query('category') category?: string,
    @Query('period') period?: string,
  ) {
    return this.reputationService.getLeaderboard(category, period);
  }

  /**
   * Returns the full agent_stats row for a given agent UUID.
   * Includes win rate, completion rate, composite score, and ATOM-derived fields.
   * Requires authentication.
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
}
