export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? '',
    heliusApiKey: process.env.HELIUS_API_KEY ?? '',
    heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET ?? '',
    escrowProgramId: process.env.ESCROW_PROGRAM_ID ?? '',
    usdcMint: process.env.USDC_MINT ?? '',
    treasuryTokenAccount: process.env.TREASURY_TOKEN_ACCOUNT ?? '',
  },

  authority: {
    privateKey: process.env.AUTHORITY_PRIVATE_KEY ?? '[]',
  },

  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ?? '',
  },

  redis: {
    restUrl: process.env.UPSTASH_REDIS_REST_URL ?? '',
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
    url: process.env.REDIS_URL ?? '',
  },

  jwt: {
    privateKey: process.env.JWT_PRIVATE_KEY ?? '',
    publicKey: process.env.JWT_PUBLIC_KEY ?? '',
  },

  pinataJwt: process.env.PINATA_JWT ?? '',

  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
});
