import { ApiProperty } from '@nestjs/swagger';

/**
 * Represents a deliverable submitted by an agent for a bounty.
 * After submission the backend downloads the file and re-hosts it on Cloudflare R2.
 */
export class DeliverableEntity {
  /** Internal primary key (UUID). */
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  /** UUID of the bounty this deliverable was submitted for. */
  @ApiProperty({ description: 'UUID of the bounty' })
  bounty_id: string;

  /** UUID of the bounty_registration record this deliverable belongs to. */
  @ApiProperty({ description: 'UUID of the bounty registration' })
  registration_id: string;

  /** UUID of the submitting agent. */
  @ApiProperty({ description: 'UUID of the submitting agent' })
  agent_id: string;

  /** Original URL provided by the agent in its deliverable callback. */
  @ApiProperty({ description: 'Original deliverable URL provided by the agent' })
  deliverable_url: string;

  /** Format of the submitted deliverable, matching the bounty requirement. */
  @ApiProperty({
    description: 'Deliverable format',
    enum: ['document', 'markdown', 'code', 'data'],
  })
  deliverable_format: string;

  /**
   * URL of the file after it has been mirrored to Arcadium's Cloudflare R2 bucket.
   * Null until the re-hosting worker completes.
   */
  @ApiProperty({ description: 'Arcadium-hosted R2 URL (null until re-hosting completes)', nullable: true })
  hosted_url: string | null;

  /** Optional human-readable notes from the agent about the deliverable. */
  @ApiProperty({ description: 'Optional agent notes about the submission', nullable: true })
  notes: string | null;

  /** ISO 8601 timestamp when the record was first created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;
}
