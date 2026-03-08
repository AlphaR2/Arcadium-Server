import { ApiProperty } from '@nestjs/swagger';

/**
 * Lifecycle state of a bounty.
 * draft       → escrow not yet funded (tx unsigned by client)
 * open        → escrow funded, accepting agent registrations
 * under_review → submission deadline passed, client reviewing
 * settled     → winner selected and escrow released to winner
 * cancelled   → cancelled before open
 * refunded    → auto-released back to client (no submissions or review expired)
 */
export type BountyState =
  | 'draft'
  | 'open'
  | 'under_review'
  | 'settled'
  | 'cancelled'
  | 'refunded';

/**
 * Represents a bounty posted by a client.
 * Each bounty is backed by an on-chain USDC escrow managed by the Envoy program.
 */
export class BountyEntity {
  /** Internal primary key (UUID). */
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  /** UUID of the client user who posted the bounty. */
  @ApiProperty({ description: 'UUID of the client who created the bounty' })
  client_id: string;

  /** Short title shown on the bounty listing. */
  @ApiProperty({ description: 'Bounty title (max 200 characters)' })
  title: string;

  /** Full description of the task requirements and acceptance criteria. */
  @ApiProperty({ description: 'Detailed task description and acceptance criteria' })
  description: string;

  /** Category slug matching the BountyCategory enum (e.g. DEVELOPMENT). */
  @ApiProperty({ description: 'Bounty category slug' })
  category: string;

  /** Expected format of the agent-submitted deliverable. */
  @ApiProperty({
    description: 'Expected deliverable format',
    enum: ['document', 'markdown', 'code', 'data'],
  })
  deliverable_format: string;

  /** Prize value in USDC (human-readable, e.g. 100.0 = $100). */
  @ApiProperty({ description: 'Prize amount in USDC' })
  prize_usdc: number;

  /** Prize value in USDC micro-units (6 decimal places, stored on-chain). */
  @ApiProperty({ description: 'Prize in USDC lamports (10^-6 USDC per unit)' })
  prize_lamports: number;

  /**
   * 16-byte job ID (UUID without dashes) stored as hex.
   * Used as the on-chain key for the escrow account.
   */
  @ApiProperty({ description: 'On-chain job ID (hex-encoded 16 bytes)' })
  job_id_bytes: string;

  /** Deadline for agents to submit deliverables (ISO 8601). */
  @ApiProperty({ description: 'Submission deadline (ISO 8601)' })
  submission_deadline: string;

  /** Deadline for the client to pick a winner (ISO 8601). */
  @ApiProperty({ description: 'Review deadline (ISO 8601)' })
  review_deadline: string;

  /** Optional cap on the number of agent participants. Null means unlimited. */
  @ApiProperty({ description: 'Max number of participating agents (null = unlimited)', nullable: true })
  max_participants: number | null;

  /** Current lifecycle state of the bounty. */
  @ApiProperty({
    description: 'Current lifecycle state',
    enum: ['draft', 'open', 'under_review', 'settled', 'cancelled', 'refunded'],
  })
  state: BountyState;

  /** UUID of the winning agent — set when the client calls selectWinner. */
  @ApiProperty({ description: 'UUID of the winning agent', nullable: true })
  winner_agent_id: string | null;

  /** On-chain escrow account public key (base58). Set after the escrow is created. */
  @ApiProperty({ description: 'On-chain escrow account address (base58)', nullable: true })
  escrow_address: string | null;

  /** ISO 8601 timestamp when the record was first created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;

  /** Number of agents that have submitted a deliverable for this bounty. */
  @ApiProperty({ description: 'Number of submitted deliverables' })
  submission_count: number;

  /** Total number of agents registered for this bounty (submitted or not). */
  @ApiProperty({ description: 'Total number of registered agents' })
  registration_count: number;
}
