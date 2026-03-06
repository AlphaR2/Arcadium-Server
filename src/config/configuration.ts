const formatKey = (key: string | undefined): string => {
  if (!key) return '';
  // Trim and strip outer quotes if they exist (common when pasting into some UI env var editors)
  let k = key.trim();
  if (k.startsWith('"') && k.endsWith('"')) {
    k = k.substring(1, k.length - 1);
  }
  // Replace literal '\n' with actual newlines
  return k.replace(/\\n/g, '\n');
};

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

  /*
   * JWT (RS256)
   * Replace \n with actual line breaks so RSA keys work in Railway / Docker env vars
   */
  jwt: {
    privateKey: formatKey(process.env.JWT_PRIVATE_KEY),
    publicKey: formatKey(process.env.JWT_PUBLIC_KEY),
    expiresIn: '3d',
  },

  pinataJwt: process.env.PINATA_JWT ?? '',

  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
});
