import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { BountiesRepository } from './bounties.repository';
import { EscrowService } from '../escrow/escrow.service';
import { AgentsRepository } from '../agents/agents.repository';
import { UsersService } from '../users/users.service';
import { SelectWinnerResponse } from '../../common/interfaces';

/**
 * Handles winner selection and escrow settlement for bounties.
 * Coordinates between the DB, escrow program, and agent/user records.
 */
@Injectable()
export class BountiesReviewService {
  private readonly logger = new Logger(BountiesReviewService.name);

  constructor(
    private readonly bountiesRepository: BountiesRepository,
    private readonly escrowService: EscrowService,
    private readonly agentsRepository: AgentsRepository,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Builds an unsigned settle_escrow tx for the client to claim their refund.
   * Only callable when state=awaiting_refund — update_escrow(UnFulfilled) must
   * have already been authority-signed (by the deadline cron or a cancel flow).
   * Returns base64-encoded tx for Phantom to sign + broadcast.
   */
  async claimRefund(
    bountyId: string,
    clientPubkey: string,
    clientId: string,
  ): Promise<{ tx: string }> {
    this.logger.log(`claimRefund bounty=${bountyId} client=${clientId}`);

    const bounty = await this.bountiesRepository.findById(bountyId);
    if (!bounty) throw new NotFoundException('Bounty not found');

    if (bounty.client_id !== clientId) {
      throw new BadRequestException('Only the bounty client can claim a refund');
    }

    if ((bounty as unknown as Record<string, unknown>)['state'] !== 'awaiting_refund') {
      throw new BadRequestException(
        `Bounty is not awaiting refund (current state: ${(bounty as unknown as Record<string, unknown>)['state']})`,
      );
    }

    const tx = await this.escrowService.buildRefundTx({
      jobIdBytes: bounty.job_id_bytes as unknown as Buffer,
      clientPubkey,
    });

    return { tx };
  }

  /**
   * Selects a winner for a bounty and initiates escrow settlement.
   *
   * Steps:
   *   1. Verify the caller (clientId) is the bounty owner.
   *   2. Call update_escrow (authority-signed) to set fulfilled=true and agentOwner on-chain.
   *   3. Update the bounty DB record with winner_agent_id and state=settled.
   *   4. Build an unsigned settle_escrow tx for the client to sign via Phantom.
   *
   * The settle_escrow tx, when broadcast, transfers USDC from escrow to the winner's ATA.
   */
  async selectWinner(
    bountyId: string,
    winnerAgentId: string,
    clientPubkey: string,
    clientId: string,
  ): Promise<SelectWinnerResponse> {
    this.logger.log(`selectWinner bounty=${bountyId} winner=${winnerAgentId}`);

    /* Load and validate the bounty — must exist and belong to this client */
    const bounty = await this.bountiesRepository.findById(bountyId);
    if (!bounty) throw new NotFoundException('Bounty not found');

    if (bounty.client_id !== clientId) {
      throw new BadRequestException('Only the bounty client can select a winner');
    }

    /* Load the winning agent to get its owner's user ID */
    const agent = await this.agentsRepository.findById(winnerAgentId);
    if (!agent) throw new NotFoundException('Winner agent not found');

    /* Load the agent owner to obtain their on-chain wallet pubkey */
    const agentOwner = await this.usersService.findById(agent.owner_id);
    if (!agentOwner) throw new NotFoundException('Agent owner not found');

    /*
     * Step 2: Authority-signed update_escrow instruction.
     * Sets fulfilled=true and records the winner's wallet pubkey on-chain,
     * enabling the settle_escrow instruction to release funds to the correct ATA.
     */
    await this.escrowService.callUpdateEscrow({
      jobIdBytes: bounty.job_id_bytes as unknown as Buffer,
      clientPubkey,
      fulfilled: true,
      agentOwner: agentOwner.pubkey,
    });

    /* Step 3: Update DB — mark winner and transition state to settled */
    await this.bountiesRepository.update(bountyId, {
      winner_agent_id: winnerAgentId,
      state: 'settled',
    });

    /*
     * Step 4: Build the unsigned settle_escrow tx.
     * The client signs this with Phantom; on broadcast it releases the USDC escrow
     * to the winner's Associated Token Account.
     */
    const tx = await this.escrowService.buildSettleTx({
      jobIdBytes: bounty.job_id_bytes as unknown as Buffer,
      clientPubkey,
      winnerPubkey: agentOwner.pubkey,
    });

    return { tx };
  }
}
