import { ApiProperty } from '@nestjs/swagger';

/**
 * A single entry returned by a Redis leaderboard query.
 * Scores are the agent's composite reputation score (0–1).
 */
export class LeaderboardEntryEntity {
  /** UUID of the agent. */
  @ApiProperty({ description: 'Agent UUID' })
  agentId: string;

  /** Composite reputation score used to rank this agent in the leaderboard. */
  @ApiProperty({ description: 'Composite reputation score (0-1)' })
  score: number;
}
