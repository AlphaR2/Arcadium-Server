import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { BountiesRepository } from '../bounties/bounties.repository';
import { AgentsRepository } from '../agents/agents.repository';
import { ReputationService } from '../reputation/reputation.service';
import { AtomService } from '../reputation/atom.service';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { SolanaSDK } from '8004-solana';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as bs58 from 'bs58';

// Instruction discriminators — from Codama-generated client (sha256("global:<snake_case_name>")[0..8])
const DISCRIMINATORS = {
  createEscrow: Buffer.from([253, 215, 165, 116, 36, 108, 68, 80]),
  settleEscrow: Buffer.from([22, 135, 160, 194, 23, 186, 124, 110]),
  updateEscrow: Buffer.from([252, 228, 127, 1, 60, 43, 54, 28]),
};

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Injectable()
export class HeliusService {
  private readonly logger = new Logger(HeliusService.name);
  private readonly supabase: SupabaseClient;
  private readonly escrowProgramId: string;

  /**
   * Authority-signed 8004 SDK instance.
   * Used to call sdk.setMetadata() after an agent's registration NFT is confirmed.
   */
  private readonly authoritySDK: SolanaSDK;

  constructor(
    private readonly config: ConfigService,
    private readonly bountiesRepository: BountiesRepository,
    private readonly agentsRepository: AgentsRepository,
    private readonly reputationService: ReputationService,
    private readonly atomService: AtomService,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
    this.escrowProgramId = this.config.get<string>('solana.escrowProgramId') ?? '';

    const rawKey = this.config.get<string>('authority.privateKey') ?? '[]';
    const signer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(rawKey) as number[]),
    );
    this.authoritySDK = new SolanaSDK({
      cluster: 'devnet',
      rpcUrl: this.config.get<string>('solana.rpcUrl'),
      signer,
    });
  }

  /** Routes an enhanced transaction event to the appropriate handler. */
  async route(tx: Record<string, unknown>): Promise<void> {
    const instructions = (tx['instructions'] as Array<Record<string, unknown>>) ?? [];

    for (const ix of instructions) {
      if (ix['programId'] !== this.escrowProgramId) continue;

      const dataStr = ix['data'] as string;
      if (!dataStr) continue;

      const decoded = Buffer.from(
        bs58.default.decode ? bs58.default.decode(dataStr) : (bs58 as unknown as { decode: (s: string) => Uint8Array }).decode(dataStr),
      );
      if (decoded.length < 8) continue;

      const discriminator = decoded.subarray(0, 8);

      if (discriminator.equals(DISCRIMINATORS.createEscrow)) {
        await this.handleEscrowFunded(decoded, ix);
      } else if (discriminator.equals(DISCRIMINATORS.settleEscrow)) {
        await this.handleSettleConfirmed(decoded);
      }
    }

    // Also check for 8004 agent registrations in any instruction
    await this.handlePotentialAgentRegistration(tx);
  }

  /**
   * createEscrow confirmed: update job to 'open' state.
   * Instruction data layout: [8 discriminator][16 jobId][1 jobType][8 amount][8 expiry]
   * Accounts: [0] client, [1] config, [2] escrowVaultState, [3] escrowVault, ...
   */
  private async handleEscrowFunded(
    data: Buffer,
    ix: Record<string, unknown>,
  ): Promise<void> {
    const jobIdBytes = data.subarray(8, 24);
    const jobUuid = bytesToUuid(jobIdBytes);

    this.logger.log(`handleEscrowFunded jobUuid=${jobUuid}`);

    const { data: job } = await this.supabase
      .from('bounties')
      .select('id')
      .eq('job_id_bytes', Array.from(jobIdBytes))
      .single();

    if (!job) {
      this.logger.warn(`No bounty found for jobId ${jobUuid}`);
      return;
    }

    const accounts = (ix['accounts'] as string[]) ?? [];
    const escrowVaultState = accounts[2];

    await this.supabase
      .from('bounties')
      .update({ state: 'open', escrow_pda: escrowVaultState })
      .eq('id', (job as Record<string, string>)['id']);

    this.logger.log(`Bounty ${(job as Record<string, string>)['id']} → open`);
  }

  /**
   * settleEscrow confirmed on-chain.
   * Two paths:
   *   - Win  (winner_agent_id set)   → state=completed, write ATOM + reputation
   *   - Refund (no winner_agent_id)  → state=refunded, skip ATOM + reputation
   *
   * Instruction data layout: [8 discriminator][16 jobId]
   */
  private async handleSettleConfirmed(data: Buffer): Promise<void> {
    const jobIdBytes = data.subarray(8, 24);
    const jobUuid = bytesToUuid(jobIdBytes);

    this.logger.log(`handleSettleConfirmed jobUuid=${jobUuid}`);

    const { data: job } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('job_id_bytes', Array.from(jobIdBytes))
      .single();

    if (!job) return;

    const bounty = job as BountyEntity;

    if (bounty.winner_agent_id) {
      /* Win path: update state, write ATOM feedback, update internal reputation */
      await this.supabase
        .from('bounties')
        .update({ state: 'completed' })
        .eq('id', bounty.id);

      await this.atomService.writeBountyFeedback(bounty as unknown as Record<string, unknown>);
      await this.reputationService.handleBountyCompleted(bounty);

      this.logger.log(`Bounty ${bounty.id} completed — reputation updated`);
    } else {
      /* Refund path: escrow was settled as UnFulfilled → funds back to client */
      await this.supabase
        .from('bounties')
        .update({ state: 'refunded' })
        .eq('id', bounty.id);

      this.logger.log(`Bounty ${bounty.id} refunded`);
    }
  }

  /**
   * Scans all tx accounts for matches against pending agent pubkeys.
   * On match: promotes pending_asset_pubkey → asset_pubkey in DB and calls
   * sdk.setMetadata to link the 8004 NFT to our internal agent ID.
   */
  private async handlePotentialAgentRegistration(
    tx: Record<string, unknown>,
  ): Promise<void> {
    const accounts: string[] = [];

    const instructions = (tx['instructions'] as Array<Record<string, unknown>>) ?? [];
    for (const ix of instructions) {
      const ixAccounts = (ix['accounts'] as string[]) ?? [];
      accounts.push(...ixAccounts);
    }

    if (accounts.length === 0) return;

    for (const acct of accounts) {
      const agent = await this.agentsRepository.findByPendingAsset(acct);
      if (!agent) continue;

      this.logger.log(`8004 registration confirmed: agent=${agent.id} assetPubkey=${acct}`);

      /* Promote pending → confirmed in DB */
      await this.agentsRepository.update(agent.id, {
        asset_pubkey: acct,
        pending_asset_pubkey: null,
        health_status: 'healthy',
      });

      /* Link 8004 NFT to our internal agent UUID via on-chain metadata */
      try {
        await this.authoritySDK.setMetadata(
          new PublicKey(acct),
          'envoy_agent_id',
          agent.id,
        );
        this.logger.log(`setMetadata envoy_agent_id=${agent.id} written for ${acct}`);
      } catch (err) {
        /* Non-fatal — DB is already updated. Metadata can be retried manually. */
        this.logger.warn(`setMetadata failed for ${acct}: ${String(err)}`);
      }
    }
  }
}
