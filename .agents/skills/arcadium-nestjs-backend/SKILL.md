---
name: arcadium-nestjs-backend
description: Skill for building, modifying, or understanding the Arcadium NestJS backend. Use whenever working on backend modules, API routes, database schema, queue workers, Helius webhook handling, escrow transaction construction, 8004 SDK integration, or reputation writes. Always load arcadium-general first.
---

# arcadium-nestjs-backend — Backend Skill

NestJS monolith hosted on Railway. Handles all business logic, transaction construction, agent registration, bounty lifecycle, reputation writes, and queue management. The mobile app consumes this backend exclusively — it never touches Solana RPC directly except to sign and broadcast client-signed transactions.

---

## Signing Model (Critical)

Two distinct categories of backend operations:

**Client-signed transactions** — backend constructs and serializes, returns base64 tx to app, app signs via Phantom, app broadcasts directly.
- `create_escrow` — client funds bounty
- `settle_escrow` — client releases or refunds

**Authority-signed transactions** — backend wallet on Railway signs and broadcasts. App never involved.
- `update_escrow` — backend marks job Fulfilled or UnFulfilled
- 8004 feedback writes — backend writes ATOM reputation after job completion
- 8004 `setMetadata` — backend links asset_pubkey to internal agent ID
- `auto_release` — permissionless but backend triggers it on deadline

Authority wallet keypair = `ArcadiumConfig.authority` = `EIGHT004_SDK_SIGNER`. Same keypair for MVP. Stored in Railway env, never exposed.

---

## Tech Stack

```
Runtime:       Node.js (LTS) + TypeScript
Framework:     NestJS
Database:      Supabase (PostgreSQL)
Cache/Queue:   Upstash Redis + BullMQ
File storage:  Cloudflare R2
RPC:           Helius (devnet for MVP)
Agent registry: 8004-solana SDK (v0.7.6)
IPFS:          Pinata (agent metadata only)
Auth:          Wallet signature → RS256 JWT + Redis refresh token
Hosting:       Railway
```

---

## Environment Variables

```
# Solana
SOLANA_RPC_URL
HELIUS_API_KEY
HELIUS_WEBHOOK_SECRET       -- HMAC secret for validating inbound Helius payloads
ESCROW_PROGRAM_ID
USDC_MINT

# Authority wallet
AUTHORITY_PRIVATE_KEY       -- JSON array format. Signs update_escrow and 8004 writes.

# Supabase
SUPABASE_URL
SUPABASE_SERVICE_KEY

# Redis
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

# R2
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME

# JWT
JWT_PRIVATE_KEY             -- RS256 private key
JWT_PUBLIC_KEY              -- RS256 public key

# 8004
PINATA_JWT                  -- for agent metadata IPFS uploads

# App
PORT
NODE_ENV
```

---

## Database Schema

```sql
-- users
CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pubkey               VARCHAR(44) UNIQUE NOT NULL,
  display_name         VARCHAR(50),
  user_type            VARCHAR(10) CHECK (user_type IN ('client', 'owner', 'both')),
  preferred_categories TEXT[],
  onboarding_completed BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- agents
CREATE TABLE agents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             UUID REFERENCES users(id),
  asset_pubkey         VARCHAR(44),                   -- 8004 NFT address, set after registration confirmed
  name                 VARCHAR(100) NOT NULL,
  description          TEXT,
  categories           TEXT[] NOT NULL,               -- subset of 4 MVP categories
  specialisation_tags  TEXT[],
  supported_formats    TEXT[],                        -- auto-discovered via EndpointCrawler
  webhook_url          TEXT NOT NULL,
  webhook_secret       TEXT NOT NULL,                 -- HMAC secret, shown once at registration
  health_status        VARCHAR(20) DEFAULT 'pending', -- pending | live | partially | not_live
  registration_state   VARCHAR(20) DEFAULT 'pending', -- pending | confirmed | failed
  ipfs_metadata_uri    TEXT,                          -- ipfs:// URI uploaded during registration
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- bounties (jobs table scoped to bounty for MVP)
CREATE TABLE bounties (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID REFERENCES users(id),
  title                VARCHAR(200) NOT NULL,
  description          TEXT NOT NULL,
  category             VARCHAR(30) NOT NULL,
  deliverable_format   VARCHAR(20) NOT NULL,          -- document | markdown | code | data
  prize_usdc           NUMERIC(18, 6) NOT NULL,
  prize_lamports       BIGINT NOT NULL,               -- prize in USDC lamports (6 decimals)
  state                VARCHAR(20) DEFAULT 'draft',   -- draft | open | under_review | completed | refunded
  escrow_pda           VARCHAR(44),                   -- set after create_escrow confirmed
  job_id_bytes         BYTEA NOT NULL,                -- UUID as 16 raw bytes, used as on-chain job_id
  registration_deadline TIMESTAMPTZ,
  submission_deadline  TIMESTAMPTZ NOT NULL,
  review_deadline      TIMESTAMPTZ NOT NULL,
  max_participants     INTEGER,                       -- NULL = unlimited
  winner_agent_id      UUID REFERENCES agents(id),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- bounty_registrations
CREATE TABLE bounty_registrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id        UUID REFERENCES bounties(id),
  agent_id         UUID REFERENCES agents(id),
  owner_id         UUID REFERENCES users(id),
  dispatch_state   VARCHAR(20) DEFAULT 'pending',  -- pending | dispatched | dispatch_failed
  dispatch_attempts INTEGER DEFAULT 0,
  dispatched_at    TIMESTAMPTZ,
  deliverable_id   UUID,                           -- NULL until submitted
  submitted_at     TIMESTAMPTZ,
  is_winner        BOOLEAN DEFAULT FALSE,
  registered_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bounty_id, agent_id)
);

-- deliverables
CREATE TABLE deliverables (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id        UUID REFERENCES bounties(id),
  agent_id         UUID REFERENCES agents(id),
  registration_id  UUID REFERENCES bounty_registrations(id),
  format           VARCHAR(20) NOT NULL,
  r2_key           TEXT NOT NULL,                  -- R2 object key
  original_url     TEXT,                           -- URL agent submitted before re-hosting
  submitted_at     TIMESTAMPTZ DEFAULT NOW()
);

-- agent_stats (one row per agent, updated after every job)
CREATE TABLE agent_stats (
  agent_id           UUID PRIMARY KEY REFERENCES agents(id),
  total_jobs         INTEGER DEFAULT 0,
  completed_jobs     INTEGER DEFAULT 0,
  bounty_entries     INTEGER DEFAULT 0,
  bounty_wins        INTEGER DEFAULT 0,
  total_earned_usdc  NUMERIC(18, 6) DEFAULT 0,
  avg_quality_rating NUMERIC(5, 2) DEFAULT 0,
  on_time_rate       NUMERIC(5, 2) DEFAULT 0,
  completion_rate    NUMERIC(5, 2) DEFAULT 0,
  bounty_win_rate    NUMERIC(5, 2) DEFAULT 0,
  composite_score    NUMERIC(8, 4) DEFAULT 0,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ratings (one per completed job, from client)
CREATE TABLE ratings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id       UUID REFERENCES bounties(id),
  agent_id        UUID REFERENCES agents(id),
  client_id       UUID REFERENCES users(id),
  quality_score   INTEGER CHECK (quality_score BETWEEN 0 AND 100),
  was_on_time     BOOLEAN,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Module Structure

```
src/
├── main.ts
├── app.module.ts
├── config/
│   └── configuration.ts           -- typed env config via @nestjs/config
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   └── wallet-auth.guard.ts
│   └── strategies/
│       └── jwt.strategy.ts
├── users/
│   ├── users.module.ts
│   ├── users.controller.ts
│   └── users.service.ts
├── agents/
│   ├── agents.module.ts
│   ├── agents.controller.ts
│   ├── agents.service.ts          -- registration flow, health checks
│   ├── agents.repository.ts
│   └── dto/
│       ├── create-agent.dto.ts
│       └── update-agent.dto.ts
├── bounties/
│   ├── bounties.module.ts
│   ├── bounties.controller.ts
│   ├── bounties.service.ts        -- creation, browse, detail
│   ├── bounties-registration.service.ts  -- register agent, trigger dispatch
│   ├── bounties-review.service.ts        -- winner selection, update_escrow call
│   ├── bounties-scheduler.service.ts     -- cron: deadline transitions
│   ├── bounties.repository.ts
│   └── dto/
│       ├── create-bounty.dto.ts
│       └── register-agent.dto.ts
├── escrow/
│   ├── escrow.module.ts
│   └── escrow.service.ts          -- tx construction + authority wallet broadcasts
├── webhooks/
│   ├── webhooks.module.ts
│   ├── helius.controller.ts       -- inbound Helius program events
│   ├── helius.service.ts          -- state transition handler
│   ├── deliverables.controller.ts -- inbound agent callbacks
│   └── deliverables.service.ts    -- download, re-host to R2, link to bounty
├── reputation/
│   ├── reputation.module.ts
│   ├── reputation.controller.ts
│   ├── reputation.service.ts      -- internal stats writes + Redis leaderboard
│   └── atom.service.ts            -- 8004 feedback writes
├── storage/
│   └── r2.service.ts              -- Cloudflare R2 upload + signed URL generation
├── queue/
│   ├── queue.module.ts
│   ├── dispatch.processor.ts      -- BullMQ: send webhook to agent
│   ├── health-check.processor.ts  -- BullMQ: sdk.isItAlive() every 6h
│   └── deadline.processor.ts      -- BullMQ: cron every 15min, deadline transitions
└── common/
    ├── filters/
    │   └── http-exception.filter.ts
    ├── guards/
    │   └── hmac.guard.ts          -- validates HMAC on agent webhook callbacks
    └── interceptors/
        └── logging.interceptor.ts
```

---

## Auth Module

Wallet-signature only. No email or password.

```typescript
// Flow
// 1. App sends: { pubkey, signature, nonce }
// 2. Backend verifies Ed25519 signature against nonce
// 3. Upserts user record by pubkey
// 4. Issues access token (3d RS256 JWT) + refresh token (30d Redis)

// Access token payload
interface JwtPayload {
  sub: string;           // userId
  pubkey: string;
  roles: string[];
  preferred_categories: string[];
  exp: number;
}

// Redis refresh token key
// refresh:{userId}:{sha256(refreshToken)}  TTL: 30d

// Endpoints
POST /auth/verify      { pubkey, signature, nonce }  -> { accessToken, refreshToken }
POST /auth/refresh     { refreshToken }              -> { accessToken }
POST /auth/logout      { refreshToken }              -> 204
```

Nonce is a server-issued random string. App fetches nonce, signs it with Phantom, sends back. Backend never stores the signed message — only the nonce with a short TTL (5min) in Redis.

---

## Agents Module — Registration Flow

```typescript
// agents.service.ts — registerAgent()

async registerAgent(dto: CreateAgentDto, ownerPubkey: string): Promise<{ tx: string }> {
  // 1. Health check — must pass before anything else
  const tempSdk = new SolanaSDK({ cluster: 'devnet' });
  // isItAlive needs an asset pubkey — for pre-registration we ping the URL directly
  const health = await this.pingWebhook(dto.webhookUrl);
  if (!health) throw new BadRequestException('webhook unreachable');

  // 2. Auto-discover capabilities
  const crawler = new EndpointCrawler(5000);
  const capabilities = await crawler.fetchMcpCapabilities(dto.webhookUrl).catch(() => null);
  const supportedFormats = capabilities?.mcpTools?.map(t => t.name) ?? dto.supportedFormats;

  // 3. Build 8004 metadata
  const metadata = buildRegistrationFileJson({
    name: dto.name,
    description: dto.description,
    image: dto.imageUri ?? 'ipfs://QmDefaultArcadiumAgent',
    services: [{ type: ServiceType.MCP, value: dto.webhookUrl }],
    skills: dto.skills ?? [],
    domains: dto.domains ?? [],
  });

  // 4. Upload to IPFS via Pinata
  const cid = await this.ipfs.addJson(metadata);
  const metadataUri = `ipfs://${cid}`;

  // 5. Generate webhook secret
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // 6. Create agent record in DB (pending state)
  const agent = await this.agentsRepository.create({
    ownerId: ownerUser.id,
    name: dto.name,
    description: dto.description,
    categories: dto.categories,
    specialisationTags: dto.tags,
    supportedFormats,
    webhookUrl: dto.webhookUrl,
    webhookSecret,
    ipfsMetadataUri: metadataUri,
    registrationState: 'pending',
  });

  // 7. Build unsigned 8004 registration tx
  const sdk = new SolanaSDK({ cluster: 'devnet' });
  const assetKeypair = Keypair.generate();
  const prepared = await sdk.registerAgent(metadataUri, {
    atomEnabled: true,
    skipSend: true,
    signer: new PublicKey(ownerPubkey),
    assetPubkey: assetKeypair.publicKey,
  });

  // Store expected asset pubkey so Helius confirmation can find the agent record
  await this.agentsRepository.setPendingAsset(agent.id, assetKeypair.publicKey.toBase58());

  // Return: tx for Phantom to sign + webhookSecret (shown once)
  return {
    agentId: agent.id,
    tx: prepared.transaction,       // base64 unsigned tx
    webhookSecret,                  // shown once in mobile app
    assetPubkey: assetKeypair.publicKey.toBase58(),
  };
}
```

On Helius confirmation of the registration tx:
```typescript
// helius.service.ts
async handleAgentRegistered(assetPubkey: string) {
  const agent = await this.agentsRepository.findByPendingAsset(assetPubkey);
  if (!agent) return;

  // Link 8004 NFT to internal record
  const sdk = this.getAuthoritySDK();
  await sdk.setMetadata(
    new PublicKey(assetPubkey),
    'arcadium_agent_id',
    agent.id,
  );

  await this.agentsRepository.update(agent.id, {
    assetPubkey,
    registrationState: 'confirmed',
    healthStatus: 'live',
  });
}
```

---

## Bounties Module — Full Lifecycle

### Creation

```typescript
// bounties.service.ts — createBounty()
// Returns unsigned create_escrow tx for client to sign via Phantom

async createBounty(dto: CreateBountyDto, clientPubkey: string): Promise<{ tx: string, bountyId: string }> {
  const jobIdBytes = uuidToBytes(randomUUID());   // UUID → 16 raw bytes

  // Store bounty in DB (state: draft)
  const bounty = await this.bountiesRepository.create({
    clientId: client.id,
    title: dto.title,
    description: dto.description,
    category: dto.category,
    deliverableFormat: dto.deliverableFormat,
    prizeUsdc: dto.prizeUsdc,
    prizeLamports: usdcToLamports(dto.prizeUsdc),
    jobIdBytes,
    submissionDeadline: dto.submissionDeadline,
    reviewDeadline: dto.reviewDeadline,
    maxParticipants: dto.maxParticipants ?? null,
    state: 'draft',
  });

  // Construct unsigned create_escrow tx
  const tx = await this.escrowService.buildCreateEscrowTx({
    jobId: jobIdBytes,
    jobType: JobType.Bounty,
    clientPubkey,
    prizeLamports: bounty.prizeLamports,
    expiry: toUnixTimestamp(dto.reviewDeadline),
  });

  return { tx, bountyId: bounty.id };
}
```

### Helius confirms create_escrow

```typescript
// State: draft → open
async handleEscrowFunded(escrowPda: string, jobIdBytes: Buffer) {
  const bounty = await this.bountiesRepository.findByJobId(jobIdBytes);
  await this.bountiesRepository.update(bounty.id, {
    state: 'open',
    escrowPda,
  });
  // Category-targeted push (post-MVP) — skipped for MVP
}
```

### Agent Registration + Immediate Dispatch

```typescript
// bounties-registration.service.ts

async registerAgent(bountyId: string, agentId: string, ownerPubkey: string) {
  const bounty = await this.bountiesRepository.findById(bountyId);

  require(bounty.state === 'open', 'bounty not open');
  require(!bounty.registrationDeadline || now() < bounty.registrationDeadline, 'registration closed');

  if (bounty.maxParticipants) {
    const count = await this.registrationsRepository.count(bountyId);
    require(count < bounty.maxParticipants, 'bounty full');
  }

  const reg = await this.registrationsRepository.create({
    bountyId,
    agentId,
    ownerId: owner.id,
    dispatchState: 'pending',
  });

  // Dispatch immediately on registration
  await this.dispatchQueue.add('dispatch', {
    registrationId: reg.id,
    bountyId,
    agentId,
  }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

  return reg;
}
```

### Dispatch Worker

```typescript
// queue/dispatch.processor.ts

@Processor('dispatch')
export class DispatchProcessor {
  async process(job: Job) {
    const { registrationId, bountyId, agentId } = job.data;

    const [bounty, agent, reg] = await Promise.all([
      this.bountiesRepository.findById(bountyId),
      this.agentsRepository.findById(agentId),
      this.registrationsRepository.findById(registrationId),
    ]);

    const participantCount = await this.registrationsRepository.count(bountyId);

    const payload = {
      arcadium_signature: this.hmac(agent.webhookSecret, JSON.stringify(body)),
      job_id: bounty.id,
      job_type: 'bounty',
      registration_id: reg.id,
      task: {
        title: bounty.title,
        description: bounty.description,
        deliverable_format: bounty.deliverableFormat,
        deadline_utc: bounty.submissionDeadline.toISOString(),
      },
      client_id: bounty.clientId,
      participant_count: participantCount,
      callback_url: `${process.env.API_URL}/deliverables/submit`,
    };

    try {
      await axios.post(agent.webhookUrl, payload, { timeout: 10_000 });
      await this.registrationsRepository.update(reg.id, {
        dispatchState: 'dispatched',
        dispatchedAt: new Date(),
      });
    } catch {
      await this.registrationsRepository.update(reg.id, {
        dispatchState: 'dispatch_failed',
        dispatchAttempts: reg.dispatchAttempts + 1,
      });
      throw new Error('dispatch failed — BullMQ will retry');
    }
  }
}
```

### Deliverable Callback

```typescript
// webhooks/deliverables.service.ts

async handleDeliverable(dto: DeliverableCallbackDto) {
  const reg = await this.registrationsRepository.findById(dto.registration_id);
  const bounty = await this.bountiesRepository.findById(dto.job_id);

  require(bounty.state === 'open', 'submission window closed');
  require(now() < bounty.submissionDeadline, 'past deadline');

  // Download from agent URL
  const file = await this.downloadFile(dto.deliverable_url);

  // Re-host to R2
  const r2Key = `deliverables/${bounty.id}/${reg.id}/${Date.now()}`;
  await this.r2.upload(r2Key, file);

  const deliverable = await this.deliverablesRepository.create({
    bountyId: bounty.id,
    agentId: reg.agentId,
    registrationId: reg.id,
    format: dto.deliverable_format,
    r2Key,
    originalUrl: dto.deliverable_url,
  });

  await this.registrationsRepository.update(reg.id, {
    deliverableId: deliverable.id,
    submittedAt: new Date(),
  });
}
```

### Deadline Cron

```typescript
// bounties-scheduler.service.ts — runs every 15 min

@Cron('*/15 * * * *')
async handleDeadlines() {
  const now = new Date();

  // submission_deadline passed, state = open
  const expiredOpen = await this.bountiesRepository.findExpiredOpen(now);
  for (const bounty of expiredOpen) {
    const submissions = await this.registrationsRepository.countSubmitted(bounty.id);
    if (submissions === 0) {
      // Auto-refund — no agents submitted
      await this.escrowService.callAutoRelease(bounty.jobIdBytes);
      await this.bountiesRepository.update(bounty.id, { state: 'refunded' });
    } else {
      await this.bountiesRepository.update(bounty.id, { state: 'under_review' });
      // Notify client (post-MVP)
    }
  }

  // review_deadline passed, state = under_review
  const expiredReview = await this.bountiesRepository.findExpiredReview(now);
  for (const bounty of expiredReview) {
    await this.escrowService.callAutoRelease(bounty.jobIdBytes);
    await this.bountiesRepository.update(bounty.id, { state: 'refunded' });
  }
}
```

### Winner Selection

```typescript
// bounties-review.service.ts

async selectWinner(bountyId: string, winnerAgentId: string, clientPubkey: string): Promise<{ tx: string }> {
  const bounty = await this.bountiesRepository.findById(bountyId);
  const winner = await this.agentsRepository.findById(winnerAgentId);
  const winnerOwner = await this.usersRepository.findById(winner.ownerId);

  require(bounty.state === 'under_review', 'bounty not in review');
  require(bounty.clientId === client.id, 'not the bounty client');

  // 1. Backend calls update_escrow (authority signs + broadcasts)
  await this.escrowService.callUpdateEscrow({
    jobIdBytes: bounty.jobIdBytes,
    jobStatus: JobStatus.Fulfilled,
    winner: new PublicKey(winnerOwner.pubkey),
    agentOwner: new PublicKey(winnerOwner.pubkey),
  });

  // 2. Update DB
  await this.bountiesRepository.update(bounty.id, { winnerAgentId });
  await this.registrationsRepository.setWinner(bountyId, winnerAgentId);

  // 3. Build unsigned settle_escrow tx for client to sign
  const tx = await this.escrowService.buildSettleTx({
    jobIdBytes: bounty.jobIdBytes,
    clientPubkey,
    winnerPubkey: winnerOwner.pubkey,
  });

  return { tx };
}
```

On Helius confirmation of settle_escrow:
```typescript
async handleSettleConfirmed(jobIdBytes: Buffer) {
  const bounty = await this.bountiesRepository.findByJobId(jobIdBytes);
  await this.bountiesRepository.update(bounty.id, { state: 'completed' });

  // Write internal reputation
  await this.reputationService.handleBountyCompleted(bounty);

  // Write 8004 ATOM feedback
  await this.atomService.writeBountyFeedback(bounty);
}
```

---

## Escrow Module

```typescript
// escrow.service.ts

@Injectable()
export class EscrowService {
  private authority: Keypair;
  private connection: Connection;
  private program: Program<ArcadiumEscrow>;

  constructor(config: ConfigService) {
    this.authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(config.get('AUTHORITY_PRIVATE_KEY')))
    );
    this.connection = new Connection(config.get('SOLANA_RPC_URL'));
    this.program = new Program(IDL, new PublicKey(config.get('ESCROW_PROGRAM_ID')), provider);
  }

  async buildCreateEscrowTx(params: CreateEscrowParams): Promise<string> {
    const tx = await this.program.methods
      .createEscrow(params.jobId, params.jobType, new PublicKey(params.clientPubkey), params.prizeLamports, new BN(params.expiry))
      .accounts({ /* ... */ })
      .transaction();
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }

  async buildSettleTx(params: SettleParams): Promise<string> {
    const tx = await this.program.methods
      .settleEscrow(params.jobId)
      .accounts({ /* ... */ })
      .transaction();
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }

  async callUpdateEscrow(params: UpdateEscrowParams): Promise<string> {
    const sig = await this.program.methods
      .updateEscrow(params.jobId, params.jobStatus, params.winner ?? null, params.agentOwner ?? null)
      .accounts({ authority: this.authority.publicKey, /* ... */ })
      .signers([this.authority])
      .rpc();
    return sig;
  }

  async callAutoRelease(jobIdBytes: Buffer): Promise<string> {
    const sig = await this.program.methods
      .autoRelease(Array.from(jobIdBytes))
      .accounts({ /* ... */ })
      .signers([this.authority])
      .rpc();
    return sig;
  }
}
```

---

## Reputation Module

### Internal stats write (after every bounty completion)

```typescript
// reputation.service.ts

async handleBountyCompleted(bounty: Bounty) {
  const winner = await this.agentsRepository.findById(bounty.winnerAgentId);
  const allRegistrations = await this.registrationsRepository.findAll(bounty.id);

  // Update winner stats
  await this.updateAgentStats(bounty.winnerAgentId, {
    completedJobs: +1,
    bountyWins: +1,
    bountyEntries: +1,
    totalEarnedUsdc: +bounty.prizeUsdc * 0.9,
  });

  // Update all other participants
  for (const reg of allRegistrations.filter(r => r.agentId !== bounty.winnerAgentId)) {
    await this.updateAgentStats(reg.agentId, { bountyEntries: +1 });
  }

  await this.recalculateCompositeScore(bounty.winnerAgentId);
  await this.updateRedisLeaderboard(bounty.winnerAgentId);
}

private recalculateCompositeScore(agentId: string) {
  // (avg_quality_rating * 0.4) + (on_time_rate * 0.2) + (completion_rate * 0.2) + (bounty_win_rate * 0.2)
}
```

### Redis leaderboard keys

```
leaderboard:global                   ZSET  score → agentId
leaderboard:category:{CATEGORY}      ZSET  score → agentId
leaderboard:monthly:{YYYY-MM}        ZSET  score → agentId
```

### 8004 ATOM feedback writes

```typescript
// atom.service.ts

async writeBountyFeedback(bounty: Bounty) {
  const sdk = this.getAuthoritySDK();
  const winner = await this.agentsRepository.findById(bounty.winnerAgentId);
  const rating = await this.ratingsRepository.findByBountyAndAgent(bounty.id, bounty.winnerAgentId);

  if (!winner.assetPubkey) return; // 8004 registration not yet confirmed — skip

  const feedbackFile = {
    type: 'arcadium-bounty-completion',
    bounty_id: bounty.id,
    category: bounty.category,
    prize_usdc: bounty.prizeUsdc,
    quality_score: rating?.qualityScore ?? null,
    completed_at: new Date().toISOString(),
  };

  const feedbackCid = await this.ipfs.addJson(feedbackFile);
  const feedbackFileHash = await SolanaSDK.computeHash(JSON.stringify(feedbackFile));

  await sdk.giveFeedback(new PublicKey(winner.assetPubkey), {
    value: rating?.qualityScore?.toFixed(0) ?? '100',
    tag1: Tag.successRate,
    tag2: Tag.month,
    score: rating?.qualityScore ?? 100,
    endpoint: bounty.category.toLowerCase(),
    feedbackUri: `ipfs://${feedbackCid}`,
    feedbackFileHash,
  });
}

async writeHealthFeedback(agentId: string, status: 'live' | 'partially' | 'not_live', uptimePercent: number) {
  const agent = await this.agentsRepository.findById(agentId);
  if (!agent.assetPubkey) return;

  const sdk = this.getAuthoritySDK();
  const isAlive = status === 'live' || status === 'partially';

  await sdk.giveFeedback(new PublicKey(agent.assetPubkey), {
    value: isAlive ? 1 : 0,
    valueDecimals: 0,
    tag1: Tag.reachable,
    score: isAlive ? 100 : 0,
    feedbackUri: `ipfs://QmHealthCheck`, // placeholder for MVP
  });

  if (isAlive && uptimePercent > 0) {
    await sdk.giveFeedback(new PublicKey(agent.assetPubkey), {
      value: uptimePercent.toFixed(2),
      tag1: Tag.uptime,
      tag2: Tag.day,
      feedbackUri: `ipfs://QmUptimeReport`,
    });
  }
}

private getAuthoritySDK(): SolanaSDK {
  return new SolanaSDK({
    cluster: 'devnet',
    signer: this.authorityKeypair,
    rpcUrl: this.config.get('SOLANA_RPC_URL'),
  });
}
```

---

## Queue Architecture

### Three queues

**`dispatch`** — fires on agent registration. Sends task webhook to agent.
- Attempts: 3
- Backoff: exponential, 5s base
- On final failure: update `dispatch_state` to `dispatch_failed`, owner notified (post-MVP)

**`health-check`** — cron every 6 hours. All active agents.
- Calls `sdk.isItAlive(assetPubkey)` via registered service endpoint
- Updates `agents.health_status`
- Writes 8004 reachable + uptime feedback if status changed

**`deadline`** — cron every 15 minutes. Deadline transitions.
- submission_deadline passed + state open → count submissions → UNDER_REVIEW or auto-refund
- review_deadline passed + state under_review → callAutoRelease

---

## Helius Webhook Handler

```typescript
// helius.controller.ts
@Post('/webhooks/helius')
async handleHelius(@Headers('helius-signature') sig: string, @Body() body: any) {
  this.validateHeliusSignature(sig, body);  // HMAC verify against HELIUS_WEBHOOK_SECRET

  for (const event of body) {
    await this.heliusService.route(event);
  }
}

// helius.service.ts — route()
async route(event: HeliusEvent) {
  switch (event.type) {
    case 'CREATE_ESCROW':
      return this.handleEscrowFunded(event);
    case 'SETTLE_ESCROW':
      return this.handleSettleConfirmed(event);
    case 'AUTO_RELEASE':
      return this.handleAutoRelease(event);
    case 'AGENT_REGISTERED':     // 8004 program event
      return this.handleAgentRegistered(event);
  }
}
```

---

## Agent Callback HMAC Verification

Agents must sign their callbacks with the `webhook_secret` issued at registration. Backend verifies before processing any deliverable.

```typescript
// common/guards/hmac.guard.ts
@Injectable()
export class HmacGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const sig = req.headers['arcadium-signature'];
    const agent = req.agent; // pre-loaded by deliverables controller
    const expected = crypto
      .createHmac('sha256', agent.webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
}
```

---

## MVP Categories (4)

```typescript
export enum BountyCategory {
  DEVELOPMENT = 'DEVELOPMENT',
  RESEARCH    = 'RESEARCH',
  WRITING     = 'WRITING',
  SECURITY    = 'SECURITY',
}
```

---

## MVP Deliverable Formats (4)

```typescript
export enum DeliverableFormat {
  DOCUMENT = 'document',   // PDF, DOCX
  MARKDOWN = 'markdown',   // .md
  CODE     = 'code',       // any source file
  DATA     = 'data',       // JSON, CSV
}
```

---

## API Routes Summary

```
-- Auth --
POST /auth/nonce           { pubkey } -> { nonce }
POST /auth/verify          { pubkey, signature, nonce } -> { accessToken, refreshToken }
POST /auth/refresh         { refreshToken } -> { accessToken }
POST /auth/logout

-- Users --
GET  /users/me
PATCH /users/me

-- Agents --
POST /agents               create + returns unsigned 8004 registration tx
GET  /agents               browse (category, health, tier filters)
GET  /agents/:id           profile + reputation summary
GET  /agents/mine          owner's agents
PATCH /agents/:id
POST /agents/:id/health-check

-- Bounties --
POST /bounties             create + returns unsigned create_escrow tx
GET  /bounties             browse (category, prize, state, sort)
GET  /bounties/:id         detail + participant list
POST /bounties/:id/register
DELETE /bounties/:id/register/:agentId
POST /bounties/:id/retry-dispatch/:regId
GET  /bounties/:id/submissions    client only, returns signed R2 URLs (15min expiry)
POST /bounties/:id/winner         client picks winner, returns unsigned settle_escrow tx
POST /bounties/:id/cancel

-- Reputation --
GET /reputation/leaderboard          ?category=DEVELOPMENT&period=monthly
GET /reputation/agents/:id/stats

-- Inbound webhooks --
POST /webhooks/helius
POST /deliverables/submit
```

---

## Deferred (Post-MVP)

- Push notifications (Expo push tokens, notification queue)
- Gig job model
- LEGAL, FINANCE, DESIGN, DATA categories
- Dispute resolution UI
- Agent ownership transfer
- `sdk.verifyIntegrity()` trust gating before dispatch
- LEGAL / FINANCE categories
- Per-agent achievement badges
- Weekly/monthly leaderboard resets with historical snapshots