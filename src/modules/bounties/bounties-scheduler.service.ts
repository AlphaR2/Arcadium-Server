import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BountiesRepository } from './bounties.repository';
import { BountiesRegistrationService } from './bounties-registration.service';
import { EscrowService } from '../escrow/escrow.service';
import { UsersService } from '../users/users.service';

/**
 * Scheduled service that runs every 15 minutes to handle bounty deadline transitions.
 *
 * Two transitions are managed:
 *   1. submission_deadline passed + state=open
 *      → if no submissions: call update_escrow(UnFulfilled) + state=awaiting_refund
 *      → if submissions exist: state=under_review (client reviews them)
 *
 *   2. review_deadline passed + state=under_review (client did not pick a winner)
 *      → call update_escrow(UnFulfilled) + state=awaiting_refund
 *
 * After update_escrow is authority-signed on-chain, the bounty moves to
 * awaiting_refund. The client then calls POST /bounties/:id/claim-refund from
 * the mobile app to get an unsigned settle_escrow tx (UnFulfilled path).
 * On broadcast Helius confirms and sets state=refunded.
 *
 * Note: settleEscrow requires the client as signer — the backend cannot
 * broadcast it. update_escrow (authority-signed) is the only on-chain cron call.
 */
@Injectable()
export class BountiesSchedulerService {
  private readonly logger = new Logger(BountiesSchedulerService.name);

  constructor(
    private readonly bountiesRepository: BountiesRepository,
    private readonly registrationService: BountiesRegistrationService,
    private readonly escrowService: EscrowService,
    private readonly usersService: UsersService,
  ) {}

  /** Fires every 15 minutes aligned to wall-clock (:00, :15, :30, :45). */
  @Cron('*/15 * * * *')
  async handleDeadlines(): Promise<void> {
    const now = new Date();
    this.logger.log('handleDeadlines tick');

    /* --- Submission deadline check ---
     * Find open bounties whose submission_deadline has passed. */
    const expiredOpen = await this.bountiesRepository.findExpiredOpen(now);

    for (const bounty of expiredOpen) {
      const submissions = await this.registrationService.countSubmitted(bounty.id);

      if (submissions === 0) {
        /* No work submitted — mark UnFulfilled on-chain, prompt client for refund */
        await this.markUnfulfilledAndAwaitRefund(
          bounty.id,
          bounty.client_id,
          bounty.job_id_bytes,
        );
      } else {
        /* Submissions exist — move to review for the client to pick a winner */
        await this.bountiesRepository.update(bounty.id, { state: 'under_review' });
        this.logger.log(`Bounty ${bounty.id} → under_review (${submissions} submission(s))`);
      }
    }

    /* --- Review deadline check ---
     * Find under_review bounties whose review_deadline has passed.
     * Client did not select a winner in time. */
    const expiredReview = await this.bountiesRepository.findExpiredReview(now);

    for (const bounty of expiredReview) {
      await this.markUnfulfilledAndAwaitRefund(
        bounty.id,
        bounty.client_id,
        bounty.job_id_bytes,
      );
    }
  }

  /**
   * Calls update_escrow(fulfilled=false) — authority signs + broadcasts on-chain.
   * Then sets DB state to awaiting_refund so the client can claim via the app.
   */
  private async markUnfulfilledAndAwaitRefund(
    bountyId: string,
    clientId: string,
    jobIdBytesRaw: unknown,
  ): Promise<void> {
    const client = await this.usersService.findById(clientId);
    if (!client) {
      this.logger.warn(`Client ${clientId} not found for bounty ${bountyId} — skipping`);
      return;
    }

    try {
      await this.escrowService.callUpdateEscrow({
        jobIdBytes: jobIdBytesRaw as Buffer,
        clientPubkey: client.pubkey,
        fulfilled: false,
      });
    } catch (err) {
      this.logger.error(`callUpdateEscrow(UnFulfilled) failed for bounty ${bountyId}`, err);
      /* Non-fatal — still update DB state so the client sees the awaiting_refund status */
    }

    await this.bountiesRepository.update(bountyId, { state: 'awaiting_refund' });
    this.logger.log(`Bounty ${bountyId} → awaiting_refund`);
  }
}
