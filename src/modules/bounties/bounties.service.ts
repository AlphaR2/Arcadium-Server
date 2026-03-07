import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BountiesRepository } from './bounties.repository';
import { CreateBountyDto } from './dto/create-bounty.dto';
import { EscrowService } from '../escrow/escrow.service';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { CreateBountyResponse, BountyBrowseFilters } from '../../common/interfaces';
import * as crypto from 'crypto';

/** Converts a UUID string to a 16-byte Buffer by stripping dashes and hex-decoding. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** Converts a USDC float (e.g. 50.0) to its on-chain micro-unit representation (6 decimals). */
function usdcToLamports(usdc: number): number {
  return Math.round(usdc * 1_000_000);
}

/**
 * Core bounty business logic — creation, browsing, and detail retrieval.
 * Winner selection is handled by BountiesReviewService.
 * Agent registration and dispatch are handled by BountiesRegistrationService.
 */
@Injectable()
export class BountiesService {
  private readonly logger = new Logger(BountiesService.name);

  constructor(
    private readonly bountiesRepository: BountiesRepository,
    private readonly escrowService: EscrowService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Creates a new bounty and returns the unsigned create_escrow transaction.
   *
   * The client must sign and broadcast the tx via Phantom to fund the on-chain
   * escrow account with the USDC prize. Only after that will the bounty state
   * transition from 'draft' to 'open' (triggered by the Helius webhook on create_escrow).
   *
   * The job_id is a random UUID converted to 16 bytes — it serves as the on-chain
   * escrow account seed so the server can look up the escrow from the DB.
   */
  async createBounty(
    dto: CreateBountyDto,
    clientPubkey: string,
    clientId: string,
  ): Promise<CreateBountyResponse> {
    /* Generate a random job ID and convert to bytes for the on-chain escrow seed */
    const jobId = crypto.randomUUID();
    const jobIdBytes = uuidToBytes(jobId);
    const prizeLamports = usdcToLamports(dto.prizeUsdc);

    /* The escrow expiry is set to the review deadline (seconds since epoch) */
    const expiry = Math.floor(new Date(dto.reviewDeadline).getTime() / 1000);

    /* Persist the bounty in draft state — transitions to open after escrow funding */
    const bounty = await this.bountiesRepository.create({
      client_id: clientId,
      title: dto.title,
      description: dto.description,
      category: dto.category,
      deliverable_format: dto.deliverableFormat,
      prize_usdc: dto.prizeUsdc,
      prize_lamports: prizeLamports,
      /* Supabase integer[] column requires a plain JS array, not a Buffer */
      job_id_bytes: Array.from(jobIdBytes),
      submission_deadline: dto.submissionDeadline,
      review_deadline: dto.reviewDeadline,
      max_participants: dto.maxParticipants ?? null,
      state: 'draft',
    });

    /* Build the unsigned create_escrow instruction for the client to sign */
    const tx = await this.escrowService.buildCreateEscrowTx({
      jobIdBytes,
      jobType: 'bounty',
      clientPubkey,
      prizeLamports,
      expiry,
    });

    return { tx, bountyId: bounty.id };
  }

  /** Returns bounties matching the provided filters. Defaults to state=open. */
  async browse(filters: BountyBrowseFilters): Promise<BountyEntity[]> {
    return this.bountiesRepository.browse(filters);
  }

  /** Fetches a single bounty by UUID. Throws if not found. */
  async findById(id: string): Promise<BountyEntity> {
    return this.bountiesRepository.findById(id);
  }

  /**
   * Confirms that the createEscrow transaction has landed on-chain and
   * transitions the bounty from 'draft' → 'open'.
   *
   * Called by the frontend immediately after the client signs and broadcasts
   * the tx returned from POST /bounties. Does not depend on the Helius webhook.
   *
   * Verifies on-chain that:
   *   - The transaction is confirmed with no errors
   *   - It contains a createEscrow instruction from the escrow program
   * Then stores the escrowVaultState PDA address as escrow_pda.
   *
   * Idempotent: if the bounty is already open (Helius fired first), returns as-is.
   */
  async confirmEscrow(
    bountyId: string,
    signature: string,
    clientId: string,
  ): Promise<BountyEntity> {
    const bounty = await this.bountiesRepository.findById(bountyId);

    if (bounty.client_id !== clientId) {
      throw new UnauthorizedException('You are not the client for this bounty');
    }

    /* Idempotent — Helius may have already confirmed it */
    if (bounty.state !== 'draft') {
      this.logger.log(`Bounty ${bountyId} already ${bounty.state} — skipping confirm`);
      return bounty;
    }

    const rpcUrl = this.configService.get<string>('solana.rpcUrl') ?? '';
    const escrowProgramId = this.configService.get<string>('solana.escrowProgramId') ?? '';

    const escrowPda = await this.getEscrowPdaFromTx(signature, rpcUrl, escrowProgramId);

    const updated = await this.bountiesRepository.update(bountyId, {
      state: 'open',
      escrow_pda: escrowPda,
    });

    this.logger.log(`Bounty ${bountyId} confirmed → open | escrow_pda=${escrowPda}`);
    return updated;
  }

  /**
   * Fetches a finalized transaction from the RPC and extracts the
   * escrowVaultState PDA from the createEscrow instruction accounts.
   *
   * Account order in createEscrow (from generated client):
   *   [0] client, [1] config, [2] escrowVaultState, [3] escrowVault,
   *   [4] tokenMint, [5] clientTokenAccount, [6] tokenProgram, [7] systemProgram
   */
  private async getEscrowPdaFromTx(
    signature: string,
    rpcUrl: string,
    escrowProgramId: string,
  ): Promise<string> {
    /* Dynamic import keeps @solana/web3.js v1 out of the NestJS CJS/ESM boundary */
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection(rpcUrl, 'confirmed');

    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      throw new NotFoundException(
        'Transaction not found — it may still be propagating. Wait a few seconds and try again.',
      );
    }
    if (tx.meta?.err) {
      throw new BadRequestException(
        `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`,
      );
    }

    /* Find the createEscrow instruction by matching the escrow program ID */
    const ix = tx.transaction.message.instructions.find(
      (i) => i.programId.toBase58() === escrowProgramId,
    );

    if (!ix || !('accounts' in ix)) {
      throw new BadRequestException(
        'Transaction does not contain a createEscrow instruction for this program',
      );
    }

    const accounts = (ix as { accounts: { toBase58(): string }[] }).accounts;
    if (!accounts || accounts.length < 3) {
      throw new BadRequestException(
        'Unexpected instruction format — cannot extract escrow PDA',
      );
    }

    /* accounts[2] = escrowVaultState */
    return accounts[2].toBase58();
  }
}
