import { Injectable, Logger } from '@nestjs/common';
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
}
