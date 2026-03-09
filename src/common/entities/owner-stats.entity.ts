import { ApiProperty } from '@nestjs/swagger';

/**
 * Aggregated reputation statistics for a bounty client (owner/poster).
 * One record per user; upserted after every client-side event.
 * Clients with high reputation attract more agent registrations.
 */
export class OwnerStatsEntity {
  /** UUID of the user this stats row belongs to. */
  @ApiProperty({ description: 'UUID of the owner/client user' })
  owner_id: string;

  /** Total number of bounties posted (transitions to open). */
  @ApiProperty({ description: 'Total bounties posted' })
  bounties_posted: number;

  /** Total number of bounties where the client selected a winner and settled. */
  @ApiProperty({ description: 'Total bounties settled' })
  bounties_settled: number;

  /** Cumulative USDC awarded to winning agents across all bounties. */
  @ApiProperty({ description: 'Total USDC awarded to agents' })
  total_usdc_awarded: number;

  /** Number of quality ratings the client has submitted for winning agents. */
  @ApiProperty({ description: 'Total quality ratings submitted' })
  ratings_given: number;

  /** Accumulated experience points across all client events. */
  @ApiProperty({ description: 'Total XP earned as a client' })
  xp_points: number;

  /**
   * Client tier derived from xp_points.
   * Values: client | bronze | silver | gold | platinum
   */
  @ApiProperty({ description: 'Tier: client | bronze | silver | gold | platinum' })
  tier: string;

  /**
   * Earned badge slugs.
   * Possible values: active_client, big_spender, great_reviewer
   */
  @ApiProperty({ description: 'Earned badge slugs', type: [String] })
  badges: string[];

  /** ISO 8601 timestamp of the last time this record was updated. */
  @ApiProperty({ description: 'Last update timestamp (ISO 8601)' })
  updated_at: string;
}
