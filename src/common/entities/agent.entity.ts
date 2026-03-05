import { ApiProperty } from '@nestjs/swagger';

/** Possible health states for an agent endpoint. */
export type AgentHealthStatus = 'pending' | 'healthy' | 'degraded' | 'unhealthy';

/**
 * Represents an AI agent registered on the marketplace.
 * Agents are backed by an 8004 NFT asset on Solana for on-chain identity.
 */
export class AgentEntity {
  /** Internal primary key (UUID). */
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  /** UUID of the user who owns this agent. */
  @ApiProperty({ description: 'UUID of the owning user' })
  owner_id: string;

  /** Human-readable name shown on the marketplace listing. */
  @ApiProperty({ description: 'Human-readable agent name' })
  name: string;

  /** Optional long-form description of the agent's capabilities. */
  @ApiProperty({ description: 'Long-form capability description', nullable: true })
  description: string | null;

  /** Bounty categories this agent accepts — used for matching and leaderboards. */
  @ApiProperty({ description: 'Bounty categories this agent accepts', type: [String] })
  categories: string[];

  /** Detailed skill tags within the broad categories. */
  @ApiProperty({ description: 'Granular specialisation tags', type: [String] })
  specialisation_tags: string[];

  /** Deliverable formats this agent can produce (document, code, etc.). */
  @ApiProperty({ description: 'Supported deliverable formats', type: [String] })
  supported_formats: string[];

  /** HTTPS endpoint the platform calls to dispatch bounties and receive deliverables. */
  @ApiProperty({ description: 'Webhook URL for bounty dispatch and deliverable callbacks' })
  webhook_url: string;

  /** Shared secret used to sign/verify HMAC-SHA256 webhook payloads. */
  @ApiProperty({ description: 'HMAC-SHA256 shared secret for webhook verification' })
  webhook_secret: string;

  /** Current availability / health status of the agent endpoint. */
  @ApiProperty({
    description: 'Current health status of the agent endpoint',
    enum: ['pending', 'healthy', 'degraded', 'unhealthy'],
  })
  health_status: AgentHealthStatus;

  /**
   * Confirmed 8004 NFT asset public key (base58).
   * Null until the on-chain transaction is broadcast and detected by Helius.
   */
  @ApiProperty({
    description: 'Confirmed on-chain 8004 NFT asset public key (base58)',
    nullable: true,
  })
  asset_pubkey: string | null;

  /**
   * Asset public key generated before the user broadcasts the registration tx.
   * Stored temporarily so we can match the Helius event to this DB record.
   */
  @ApiProperty({
    description: 'Pre-broadcast pending asset public key (cleared after confirmation)',
    nullable: true,
  })
  pending_asset_pubkey: string | null;

  /** Optional IPFS or HTTPS URI for the agent's profile image. */
  @ApiProperty({ description: 'Optional image URI', nullable: true })
  image_uri: string | null;

  /** ISO 8601 timestamp when the record was first created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;
}
