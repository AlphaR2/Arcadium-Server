import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  address,
  appendTransactionMessageInstruction,
  Blockhash,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBytesEncoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  getCreateEscrowInstructionAsync,
  getUpdateEscrowInstructionAsync,
  getSettleEscrowInstructionAsync,
} from '../../common/program/generated/instructions';
import { JobType } from '../../common/program/generated/types';

export interface CreateEscrowParams {
  jobIdBytes: Buffer;
  jobType: string; // 'gig' | 'bounty'
  clientPubkey: string;
  prizeLamports: number;
  expiry: number; // unix timestamp seconds
}

export interface UpdateEscrowParams {
  jobIdBytes: Buffer;
  clientPubkey: string;
  fulfilled: boolean;
  agentOwner?: string;
}

export interface SettleParams {
  jobIdBytes: Buffer;
  clientPubkey: string;
  winnerPubkey: string;
}

// SPL Token Program ID bytes (for ATA derivation seeds)
const TOKEN_PROGRAM_BYTES = new Uint8Array([
  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
  28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
const ATA_PROGRAM_ADDRESS =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;

/** Cached blockhash to avoid hammering the RPC on every tx build. */
interface BlockhashCache {
  value: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  fetchedAt: number; // Date.now()
}

@Injectable()
export class EscrowService implements OnModuleInit {
  private readonly logger = new Logger(EscrowService.name);
  private readonly rpc: Rpc<SolanaRpcApi>;
  private authoritySigner!: KeyPairSigner;
  private blockhashCache: BlockhashCache | null = null;
  private static readonly BLOCKHASH_TTL_MS = 30_000; // 30 s — well within the ~90 s validity window

  constructor(private readonly config: ConfigService) {
    this.rpc = createSolanaRpc(this.config.get<string>('solana.rpcUrl') ?? '');
  }

  async onModuleInit(): Promise<void> {
    const rawKey = this.config.get<string>('authority.privateKey') ?? '[]';
    try {
      const keyBytes = Uint8Array.from(JSON.parse(rawKey) as number[]);
      this.authoritySigner = await createKeyPairSignerFromBytes(keyBytes);
      this.logger.log(
        `Authority signer initialized: ${this.authoritySigner.address}`,
      );
    } catch {
      this.logger.warn('Authority private key not configured or invalid');
    }
  }

  /**
   * Returns a recent blockhash, using a 30-second in-memory cache to avoid
   * hammering Helius (free tier rate-limits at ~10 req/s).
   */
  private async getCachedBlockhash(): Promise<{
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }> {
    const now = Date.now();
    if (
      this.blockhashCache &&
      now - this.blockhashCache.fetchedAt < EscrowService.BLOCKHASH_TTL_MS
    ) {
      return this.blockhashCache.value;
    }
    const { value } = await this.rpc.getLatestBlockhash().send();
    this.blockhashCache = { value, fetchedAt: now };
    return value;
  }

  /** Derives the ATA for a given wallet + mint using the ATA program. */
  private async deriveAta(
    walletPubkey: string,
    mintPubkey: string,
  ): Promise<Address> {
    const [ata] = await getProgramDerivedAddress({
      programAddress: ATA_PROGRAM_ADDRESS,
      seeds: [
        getAddressEncoder().encode(address(walletPubkey)),
        getBytesEncoder().encode(TOKEN_PROGRAM_BYTES),
        getAddressEncoder().encode(address(mintPubkey)),
      ],
    });
    return ata;
  }

  /**
   * Builds an unsigned create_escrow transaction.
   * Returns base64-encoded wire transaction for Phantom to sign + broadcast.
   */
  async buildCreateEscrowTx(params: CreateEscrowParams): Promise<string> {
    this.logger.log(`buildCreateEscrowTx client=${params.clientPubkey} prize=${params.prizeLamports / 1_000_000} USDC`);

    const clientNoop = createNoopSigner(address(params.clientPubkey));
    const usdcMint = this.config.get<string>('solana.usdcMint')!;
    const rpcUrl = this.config.get<string>('solana.rpcUrl')!;
    const jobType =
      params.jobType.toLowerCase() === 'bounty' ? JobType.Bounty : JobType.Gig;

    /* Pre-flight: verify the client's USDC ATA exists and has sufficient balance.
     * Returns 400 with a clear message instead of letting the wallet show a
     * cryptic "simulation failed" / MWA CancellationException. */
    const clientAta = await this.deriveAta(params.clientPubkey, usdcMint);
    try {
      const { value: bal } = await this.rpc
        .getTokenAccountBalance(clientAta)
        .send();
      if (BigInt(bal.amount) < BigInt(params.prizeLamports)) {
        throw new BadRequestException(
          `Insufficient USDC: wallet has ${bal.uiAmountString} USDC, bounty requires ${params.prizeLamports / 1_000_000} USDC`,
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `No USDC account found for wallet ${params.clientPubkey}. `,
      );
    }

    const ix = await getCreateEscrowInstructionAsync({
      client: clientNoop,
      tokenMint: address(usdcMint),
      jobId: new Uint8Array(params.jobIdBytes),
      jobType,
      amount: BigInt(params.prizeLamports),
      expiry: BigInt(params.expiry),
    });

    const latestBlockhash = await this.getCachedBlockhash();
    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(clientNoop, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b64 = getBase64EncodedWireTransaction(compileTransaction(txMessage) as any);

    /* Server-side simulation to catch on-chain errors before the wallet sees the tx.
     * TODO: switch to this.rpc.simulateTransaction() once you find the solution and @solana/kit resolves the
     *  BigInt serialization issue on the unitsConsumed response field. */
    try {
      const { Connection, VersionedTransaction } = await import('@solana/web3.js');
      const { value: sim } = await new Connection(rpcUrl, 'confirmed').simulateTransaction(
        VersionedTransaction.deserialize(Buffer.from(b64, 'base64')),
        { sigVerify: false, replaceRecentBlockhash: true },
      );
      if (sim.err) {
        this.logger.error(`createEscrow simulation failed: ${JSON.stringify(sim.err)} | logs: ${(sim.logs ?? []).join(' | ')}`);
        throw new BadRequestException(
          `Transaction simulation failed: ${JSON.stringify(sim.err)} — Logs: ${(sim.logs ?? []).join(' | ')}`,
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`Simulation RPC call failed (non-fatal): ${String(e)}`);
    }

    return b64;
  }

  /**
   * Builds an unsigned settle_escrow transaction.
   * Returns base64-encoded wire transaction for Phantom to sign + broadcast.
   */
  async buildSettleTx(params: SettleParams): Promise<string> {
    this.logger.log(
      `buildSettleTx client=${params.clientPubkey} winner=${params.winnerPubkey}`,
    );

    const clientNoop = createNoopSigner(address(params.clientPubkey));
    const usdcMint = this.config.get<string>('solana.usdcMint')!;
    const treasuryTokenAccount = this.config.get<string>(
      'solana.treasuryTokenAccount',
    )!;

    const recipientTokenAccount = await this.deriveAta(
      params.winnerPubkey,
      usdcMint,
    );

    const ix = await getSettleEscrowInstructionAsync({
      client: clientNoop,
      recipientTokenAccount,
      treasuryTokenAccount: address(treasuryTokenAccount),
      tokenMint: address(usdcMint),
      jobId: new Uint8Array(params.jobIdBytes),
    });

    const latestBlockhash = await this.getCachedBlockhash();

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(clientNoop, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getBase64EncodedWireTransaction(
      compileTransaction(txMessage) as any,
    );
  }

  /**
   * Calls update_escrow — authority-signed, broadcast by backend.
   * Returns the transaction signature.
   */
  async callUpdateEscrow(params: UpdateEscrowParams): Promise<string> {
    this.logger.log(
      `callUpdateEscrow client=${params.clientPubkey} fulfilled=${params.fulfilled}`,
    );

    const ix = await getUpdateEscrowInstructionAsync({
      authority: this.authoritySigner,
      client: address(params.clientPubkey),
      jobId: new Uint8Array(params.jobIdBytes),
      fulfilled: params.fulfilled,
      agentOwner: params.agentOwner ? address(params.agentOwner) : null,
    });

    const latestBlockhash = await this.getCachedBlockhash();

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.authoritySigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const wireTransaction = getBase64EncodedWireTransaction(signedTx);
    const sig = await this.rpc
      .sendTransaction(wireTransaction, { encoding: 'base64' })
      .send();

    this.logger.log(`updateEscrow tx: ${String(sig)}`);
    return String(sig);
  }

  /**
   * Builds an unsigned settle_escrow transaction for the refund path.
   * Called after update_escrow has set job_status=UnFulfilled.
   * Recipient is the client's own USDC ATA — full refund, no fee.
   * Returns base64-encoded wire transaction for Phantom to sign + broadcast.
   */
  async buildRefundTx(params: {
    jobIdBytes: Buffer;
    clientPubkey: string;
  }): Promise<string> {
    this.logger.log(`buildRefundTx client=${params.clientPubkey}`);

    const clientNoop = createNoopSigner(address(params.clientPubkey));
    const usdcMint = this.config.get<string>('solana.usdcMint')!;
    const treasuryTokenAccount = this.config.get<string>(
      'solana.treasuryTokenAccount',
    )!;

    /* For UnFulfilled path: recipient = client's own USDC ATA */
    const clientTokenAccount = await this.deriveAta(
      params.clientPubkey,
      usdcMint,
    );

    const ix = await getSettleEscrowInstructionAsync({
      client: clientNoop,
      recipientTokenAccount: clientTokenAccount,
      treasuryTokenAccount: address(treasuryTokenAccount),
      tokenMint: address(usdcMint),
      jobId: new Uint8Array(params.jobIdBytes),
    });

    const latestBlockhash = await this.getCachedBlockhash();

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(clientNoop, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getBase64EncodedWireTransaction(
      compileTransaction(txMessage) as any,
    );
  }
}
