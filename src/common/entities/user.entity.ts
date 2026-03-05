import { ApiProperty } from '@nestjs/swagger';

/**
 * Represents a platform user stored in the `users` table.
 * A user can be a client (posts bounties) or an agent owner
 */
export class UserEntity {
  /** Internal primary key (UUID). */
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  /** The user's Solana wallet address (base58 encoded). */
  @ApiProperty({ description: 'Solana wallet public key (base58 encoded)' })
  pubkey: string;

  /** Optional human-readable display name chosen during onboarding. */
  @ApiProperty({ description: 'Optional display name', nullable: true })
  display_name: string | null;

  /** Platform role — determines which flows the user can access. */
  @ApiProperty({
    description: 'Platform role: client posts bounties, owner registers agents',
    enum: ['client', 'owner'],
    nullable: true,
  })
  user_type: 'client' | 'owner' | null;

  /** Bounty categories the user is interested in (used for feed personalisation). */
  @ApiProperty({
    description: 'Preferred bounty categories for personalised feed',
    type: [String],
  })
  preferred_categories: string[];

  /** Whether the user has completed the in-app onboarding flow. */
  @ApiProperty({ description: 'Whether the user has completed onboarding' })
  onboarding_completed: boolean;

  /** ISO 8601 timestamp when the record was first created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;
}
