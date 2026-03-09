import { ApiProperty } from '@nestjs/swagger';

/**
 * Aggregated performance statistics for an agent.
 * One record per agent; upserted after every reputation event.
 * Composite score is used to rank agents in Redis leaderboards.
 */
export class AgentStatsEntity {
  /** UUID of the agent this stats row belongs to. */
  @ApiProperty({ description: 'UUID of the agent' })
  agent_id: string;

  /** Total number of bounties this agent has won. */
  @ApiProperty({ description: 'Total bounty wins' })
  bounty_wins: number;

  /** Cumulative USDC earned, net of the 10 % platform fee. */
  @ApiProperty({ description: 'Total USDC earned (net of platform fee)' })
  total_earned_usdc: number;

  /**
   * Average quality score (0–5) from client ratings after bounty settlement.
   * Only includes bounties where a rating was provided.
   */
  @ApiProperty({ description: 'Average quality rating given by clients (0-5)' })
  avg_quality_rating: number;

  /**
   * Fraction of accepted bounties delivered before the submission deadline.
   * Value in [0, 1].
   */
  @ApiProperty({ description: 'Fraction of jobs delivered on time (0-1)' })
  on_time_rate: number;

  /**
   * Fraction of registered bounties that resulted in a submitted deliverable.
   * Value in [0, 1].
   */
  @ApiProperty({ description: 'Fraction of registered bounties completed (0-1)' })
  completion_rate: number;

  /**
   * Fraction of entered bounties that this agent won.
   * Value in [0, 1].
   */
  @ApiProperty({ description: 'Win rate across entered bounties (0-1)' })
  bounty_win_rate: number;

  /**
   * Weighted composite score used for global and category leaderboards.
   * Formula: (avgQuality * 0.4) + (onTimeRate * 0.2) + (completionRate * 0.2) + (bountyWinRate * 0.2)
   */
  @ApiProperty({ description: 'Weighted composite reputation score (0-1)' })
  composite_score: number;

  /**
   * Fraction of ATOM feedback checks that reported a positive (success) outcome.
   * Value in [0, 1].
   */
  @ApiProperty({ description: 'Fraction of positive ATOM feedback events (0-1)' })
  success_rate: number;

  /** Whether the agent endpoint is currently reachable (last health check result). */
  @ApiProperty({ description: 'Whether the agent endpoint is currently reachable' })
  reachable: boolean;

  /**
   * Historical uptime fraction derived from periodic health check results.
   * Value in [0, 1].
   */
  @ApiProperty({ description: 'Historical uptime fraction (0-1)' })
  uptime: number;

  // ── Gamification fields 

  /** Total number of bounties this agent has registered for (denominator for win_rate & completion_rate). */
  @ApiProperty({ description: 'Total bounty registrations' })
  total_registrations: number;

  /** Total number of deliverables this agent has submitted. */
  @ApiProperty({ description: 'Total deliverables submitted' })
  total_submissions: number;

  /** Count of deliverables submitted before the bounty deadline (used to compute on_time_rate). */
  @ApiProperty({ description: 'Deliverables submitted before deadline' })
  on_time_submissions: number;

  /** Accumulated experience points across all events. */
  @ApiProperty({ description: 'Total XP earned' })
  xp_points: number;

  /** Current consecutive win count — bonuses awarded at 3, 5, 10. */
  @ApiProperty({ description: 'Current win streak' })
  win_streak: number;

  /**
   * Agent tier derived from composite_score.
   * Values: unranked | bronze | silver | gold | platinum
   */
  @ApiProperty({ description: 'Tier: unranked | bronze | silver | gold | platinum' })
  tier: string;

  /**
   * Earned badge slugs.
   * Possible values: first_win, hat_trick, veteran, speed_demon, consistent, five_star
   */
  @ApiProperty({ description: 'Earned badge slugs', type: [String] })
  badges: string[];

  /** ISO 8601 timestamp of the last time this record was updated. */
  @ApiProperty({ description: 'Last update timestamp (ISO 8601)' })
  updated_at: string;
}
