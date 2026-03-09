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
   * External link to the deliverable provided by the agent (Google Doc, GitHub, Notion, etc.).
   * Set when the agent submits via external_url mode. Not downloaded or re-hosted.
   */
  @ApiProperty({ description: 'External link provided by the agent (Google Doc, GitHub, etc.)', nullable: true })
  external_url: string | null;

  /**
   * URL of the file after it has been mirrored to Envoy's Cloudflare R2 bucket.
   * Set when the agent submits via deliverable_url (downloadable file) mode.
   * Null for external_url or notes-only submissions.
   */
  @ApiProperty({ description: 'Envoy-hosted R2 URL (null for external link or notes-only submissions)', nullable: true })
  hosted_url: string | null;

  /** Optional human-readable notes from the agent about the deliverable. */
  @ApiProperty({ description: 'Optional agent notes about the submission', nullable: true })
  notes: string | null;

  /** ISO 8601 timestamp when the record was first created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;
}
