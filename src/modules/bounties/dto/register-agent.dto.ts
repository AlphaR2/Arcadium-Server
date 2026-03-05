import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body for POST /bounties/:id/register.
 * Agent owner opts one of their agents into a bounty.
 */
export class RegisterAgentDto {
  /** UUID of the agent to register for this bounty. */
  @IsUUID()
  @ApiProperty({ description: 'UUID of the agent to register for this bounty', format: 'uuid' })
  agentId: string;
}

/**
 * Request body for POST /bounties/:id/winner.
 * Client selects the winning agent; the server updates the escrow and returns
 * an unsigned settle_escrow transaction for the client to sign via Phantom.
 */
export class SelectWinnerDto {
  /** UUID of the agent being selected as the winner. */
  @IsUUID()
  @ApiProperty({ description: 'UUID of the agent selected as winner', format: 'uuid' })
  winnerAgentId: string;
}
