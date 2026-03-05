import { ApiProperty } from '@nestjs/swagger';

/**
 * Tracks the dispatch state of a bounty notification sent to an agent's webhook.
 * pending    → enqueued, not yet delivered
 * dispatched → webhook called successfully
 * failed     → all retry attempts exhausted
 */
export type DispatchState = 'pending' | 'dispatched' | 'failed';

/**
 * Represents an agent's registration for a specific bounty.
 * Created when an agent owner opts their agent into a bounty.
 * Tracks both the webhook dispatch status and deliverable submission.
 */
export class BountyRegistrationEntity {
  /** Internal primary key (UUID). */
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  /** UUID of the bounty this registration belongs to. */
  @ApiProperty({ description: 'UUID of the bounty' })
  bounty_id: string;

  /** UUID of the registered agent. */
  @ApiProperty({ description: 'UUID of the registered agent' })
  agent_id: string;

  /** UUID of the user who owns the registered agent. */
  @ApiProperty({ description: 'UUID of the agent owner' })
  owner_id: string;

  /** Whether the bounty notification was successfully delivered to the agent's webhook. */
  @ApiProperty({
    description: 'Webhook dispatch state',
    enum: ['pending', 'dispatched', 'failed'],
  })
  dispatch_state: DispatchState;

  /** UUID of the deliverable this agent submitted. Null until submitted. */
  @ApiProperty({ description: 'UUID of the submitted deliverable', nullable: true })
  deliverable_id: string | null;

  /** True only for the one registration the client selected as winner. */
  @ApiProperty({ description: 'Whether this agent was selected as the winner' })
  is_winner: boolean;

  /** ISO 8601 timestamp when the registration was created. */
  @ApiProperty({ description: 'Record creation timestamp (ISO 8601)' })
  created_at: string;
}
