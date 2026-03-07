/**
 * One-time initialization script for the Envoy escrow program.
 *
 * This creates the on-chain config account (PDA seeded with "config") that
 * every createEscrow / settleEscrow transaction depends on. The transaction
 * will fail with "unknown error while processing instructions" if this account
 * doesn't exist.
 *
 * Run exactly ONCE after deploying the program to devnet/mainnet.
 * Safe to re-run — will fail cleanly with "account already in use" if called again.
 *
 * Usage:
 *   npm run initialize:escrow
 */

import * as dotenv from 'dotenv';
dotenv.config();

import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBytesEncoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';
import { getInitializeInstructionAsync } from '../src/common/program/generated/instructions/initialize';
import { ARCADIUM_ESCROW_PROGRAM_ADDRESS } from '../src/common/program/generated/programs/arcadiumEscrow';

// ─── Program parameters ────────────────────────────────────────────────────
const PLATFORM_FEE_BPS = 300;
const EMERGENCY_ADMIN  = '7gyjmugBPxx93NvdegiKz8JHeAaRYC8EbeFFuogWB9zX';
const TREASURY         = 'BVH74v5M1Vk3tW6FoF85s64J4JdRqidhmzQRPNCzGUcw';
const TOKEN_MINT       = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

async function main(): Promise<void> {
  // ─── Load env vars ─────────────────────────────────────────────────────
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const rawKey = process.env.AUTHORITY_PRIVATE_KEY;

  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not set in .env');
  if (!rawKey) throw new Error('AUTHORITY_PRIVATE_KEY is not set in .env');

  // Strip surrounding quotes that sometimes appear when copy-pasting env vars
  const cleanKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const keyBytes = Uint8Array.from(JSON.parse(cleanKey) as number[]);

  // ─── Create authority signer ───────────────────────────────────────────
  const authority = await createKeyPairSignerFromBytes(keyBytes);
  console.log('\n🔑 Authority:  ', authority.address);
  console.log('📋 Program ID: ', ARCADIUM_ESCROW_PROGRAM_ADDRESS);

  // ─── Derive and display config PDA ────────────────────────────────────
  const configPda = await getProgramDerivedAddress({
    programAddress: ARCADIUM_ESCROW_PROGRAM_ADDRESS,
    seeds: [
      // seeds: ["config"] — matches what the generated instruction uses
      getBytesEncoder().encode(Buffer.from('config')),
    ],
  });
  console.log('🏦 Config PDA: ', configPda);

  // ─── Build initialize instruction ─────────────────────────────────────
  console.log('\nBuilding initialize instruction...');
  console.log('  platformFeeBps:', PLATFORM_FEE_BPS, '(3%)');
  console.log('  emergencyAdmin:', EMERGENCY_ADMIN);
  console.log('  treasury:      ', TREASURY);
  console.log('  tokenMint:     ', TOKEN_MINT);

  const ix = await getInitializeInstructionAsync({
    authority,
    platformFeeBps: PLATFORM_FEE_BPS,
    emergencyAdmin: address(EMERGENCY_ADMIN) as Address,
    treasury:       address(TREASURY)        as Address,
    tokenMint:      address(TOKEN_MINT)      as Address,
  });

  // ─── Build and fully sign the transaction (authority has the keypair) ──
  const rpc = createSolanaRpc(rpcUrl);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );

  // Authority is the only required signer — signTransactionMessageWithSigners works here
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);

  // ─── Broadcast ─────────────────────────────────────────────────────────
  console.log('\nSending transaction...');
  const sig = await rpc
    .sendTransaction(wireTransaction, { encoding: 'base64' })
    .send();

  console.log('\n✅ Program initialized successfully!');
  console.log('Signature:', String(sig));
  console.log(
    'Explorer:  https://explorer.solana.com/tx/' + String(sig) + '?cluster=devnet',
  );
  console.log('\nThe config account now exists on-chain.');
  console.log('createEscrow transactions will work correctly from this point on.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Initialize failed:', msg);

  // Help diagnose the most common failure case
  if (msg.includes('already in use') || msg.includes('already initialized')) {
    console.error('→ The config account already exists. No action needed — program is already initialized.');
    process.exit(0);
  }

  process.exit(1);
});
