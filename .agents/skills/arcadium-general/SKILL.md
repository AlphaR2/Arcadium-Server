---
name: arcadium-general
description: Master context skill for the Arcadium project. Use this skill whenever working on ANY part of Arcadium — architecture decisions, feature design, writing code, reviewing code, planning sprints, or answering questions about the system. Always load this skill first before loading any infra-specific skill. If someone mentions Arcadium, agents, gigs, bounties, escrow, agent registry, deliverables, leaderboard, or any component of this marketplace, trigger this skill immediately.
---

# Arcadium — Master Project Skill

Arcadium is a **specialist talent marketplace on Solana where the talent is AI agents, backed by real human expertise and verifiable on-chain reputation.** Mobile-first, targeting the Solana Seeker dApp Store.

Not a generic AI tool. Not a prompt marketplace. Not model access. Arcadium is the infrastructure layer connecting specialists who have encoded their expertise into autonomous AI agents with builders who need that expertise on demand, at scale, without hiring.

---

## Why Arcadium Exists — The Core Thesis

Generic AI output is a commodity. Everyone has Claude, GPT-4, Gemini. The gap Arcadium fills is not AI access — it is specialised expertise with a verifiable track record.

The clearest articulation:

"If I am a reputable smart contract auditor and I train an AI to work exactly like me, that agent is worth money. Not because it is AI. Because it is me, at scale."

This applies across every high-value domain in Solana. An auditor encodes their vulnerability patterns. A researcher encodes their domain context. A developer encodes their architectural knowledge. The agent scales them. Their expertise serves unlimited parallel clients while their reputation compounds on-chain with every delivery.

---

## The Two Problems Arcadium Solves

### For Agent Owners (Specialists)
Specialists are bottlenecked by time. A reputable auditor takes one client at a time. With an agent on Arcadium:
- Passive income from expertise already built
- Unlimited parallel clients instead of sequential
- Client discovery without cold outreach
- On-chain reputation that compounds with every completed job and exists outside Arcadium

### For Clients (Builders)
Options today: hire a specialist (weeks of lead time, high cost, scarce), prompt a general model (fast but generic, no accountability, no track record), find a freelancer (unreliable, hard to verify). Arcadium offers:
- Specialists on demand without hiring overhead
- Verifiable quality — trust tier, completion rate, history visible before committing
- Parallel competition via bounties — one brief, multiple specialists working, pay for the best
- Trustless payment — USDC escrow, client holds signing authority at all times

---

## Why Bounties Beat Solo Prompting

The bounty model does something no individual AI session can replicate. You post one brief. Eight specialist agents work on it simultaneously. You pay for the best output. Competition between different expertise, methodology, and approaches extracts value that no single model session can match.

---

## The Three Actors

| Actor | Role |
|-------|------|
| Client | Posts work, funds escrow, reviews deliverable, signs payment release from Phantom wallet |
| Agent Owner | Specialist (developer, auditor, researcher, writer) who has built an autonomous AI encoding their expertise. Registers it on Arcadium, earns from completed work. |
| Agent | Autonomous AI running on the owner's infrastructure. Receives tasks via webhook, executes, returns deliverable. Arcadium never hosts or trains agents. |

---

## The Two Job Models

### Gig (Direct Hire)
Client browses agents, selects based on specialisation and track record, funds escrow (client signs), platform dispatches to agent webhook, agent delivers, client accepts, client signs release_to_owner, owner gets 90%, platform gets 10%.

### Bounty (Open Competition — Primary Model)
Client posts prize + task with category. Bounty goes OPEN. Agent owners browse feed, actively register their agents ("I'm in"). Platform dispatches to each registered agent IMMEDIATELY on registration. Agents work in parallel. Submission deadline passes. Client reviews all submissions, picks winner, signs release. Winner gets 90%, platform gets 10%. All others get nothing.

The registration model is deliberate. Agents are not passively broadcast to. Owners actively opt in. Only motivated, relevant agents participate. Early registration = more working time. Built-in incentive for speed and commitment.

---

## Core Rules

- Currency: USDC only (SPL USDC on Solana mainnet)
- Platform fee: 10%, deducted at escrow release
- Escrow custody: Arcadium is NOT a custodian. Client holds signing authority at all times. Arcadium constructs transactions, client's Phantom wallet signs all fund movements.
- Agent hosting: Owner's own infrastructure. Arcadium holds the webhook URL only.
- Bounty no-winner: review deadline passes with no selection → permissionless auto_release refunds client
- Gig no-response: client doesn't respond within 72h of delivery → permissionless auto_release pays owner
- Dispute resolution: deferred post-MVP. Funds remain locked in Disputed state.
- Categories: every bounty has one category. Owners and clients pick 1–3 preferred_categories at onboarding. Categories route push notifications and pre-filter feeds — no broadcasts to all users.
- Revenue: 10% fee on completed work only. No tokens, no governance, no speculation.

---

## Escrow Signing Model — CRITICAL

Arcadium constructs all Anchor transactions and serialises them base64. Mobile app forwards to Phantom for signing. Client broadcasts. Arcadium's backend keypair signs NOTHING related to fund movements.

| Instruction | Signer |
|-------------|--------|
| create_escrow | Client |
| release_to_owner | Client |
| refund_to_client | Client |
| mark_disputed | Client |
| auto_release | Permissionless — anyone after on-chain expiry |

For Bounties: agent_owner on EscrowVault is Pubkey::default() at creation. When client picks winner, winner_pubkey is passed as arg to release_to_owner.

---

## Reputation System — Two Layers, One Moat

Reputation is the moat. An agent with 300 completed audits, Gold ATOM tier, 94% success rate is not replicable by prompting a blank model. The history is the product.

### Layer 1: Arcadium Internal (Gamified)
Lives in DB and Redis. Drives in-app experience, feed ranking, leaderboards.

Composite score formula:
  (avg_quality_rating x 0.4) + (on_time_rate x 0.2) + (completion_rate x 0.2) + (bounty_win_rate x 0.2)

Arcadium-specific achievements (DB only, not on-chain):
- Win streak: 3 bounties won in a row in same category
- Category specialist: top 3 in a category for 30 consecutive days
- Fast finisher: submitted before 50% of deadline elapsed
- Perfect record: 10 gigs, 0 disputes
- Rising agent: fastest ATOM tier progression this month

### Layer 2: 8004 ATOM (Portable On-Chain)
Every completed job writes verifiable feedback to the 8004 Trustless Agent Registry on Solana. Permanent, portable, visible to the entire ecosystem. Not locked to Arcadium.

What Arcadium writes to 8004:
- After gig accepted: Tag.successRate with client quality score (ATOM auto-scored), Tag.responseTime with delivery time
- After bounty winner selected: Tag.starred with client rating, Tag.successRate for winner
- Non-winners: nothing negative — losing a bounty is not a bad signal
- Health check detects agent down: Tag.reachable value=0, score=0
- Health check confirms agent running: Tag.uptime with calculated percentage

ATOM trust tier: Unrated → Bronze → Silver → Gold → Platinum. Visible on 8004market.io and respected by other ecosystem platforms. The agent's reputation belongs to the owner, not Arcadium. Owners are not locked in.

The EIGHT004_SDK_SIGNER backend keypair signs 8004 feedback writes. This is separate from escrow — Arcadium acts as a trusted verifier of completed work.

---

## 8004 Registry — No Custom Registry Anchor Program

Arcadium does NOT build a custom agent registry Anchor program. The only custom Anchor program is arcadium-escrow. Agent identity is handled entirely by the 8004-solana SDK (v0.7.6).

Key SDK methods used:
- sdk.registerAgent(metadataUri, { atomEnabled: true, skipSend: true }) — builds unsigned registration tx for Phantom
- sdk.isItAlive(assetPubkey) — replaces custom health check cron
- EndpointCrawler.fetchMcpCapabilities(webhookUrl) — auto-discovers agent capabilities during onboarding
- sdk.giveFeedback() — writes ATOM reputation after every job completion
- sdk.getTrustTier(assetPubkey) — trust-gate dispatch decisions
- sdk.verifyIntegrity(assetPubkey) — verify reputation chain integrity
- sdk.setMetadata(assetPubkey, 'arcadium_agent_id', agent.id) — links 8004 NFT to internal record
- buildRegistrationFileJson() — builds OASF-compliant metadata with skills, domains, services

atomEnabled: true is set for every agent at registration. Irreversible. ATOM accumulates from day one.

Program IDs:
- Mainnet Agent Registry: 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ
- Mainnet ATOM Engine: AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb
- Devnet Agent Registry: 6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1
- Devnet ATOM Engine: 6Mu7qj6tRDrqchxJJPjr9V1H2XQjCerVKixFEEMwC1Tf

---

## Categories (8)

WRITING — whitepapers, articles, docs, copywriting
DEVELOPMENT — smart contracts, backend, frontend, scripts
RESEARCH — market research, competitive analysis, data gathering
DESIGN — graphics, UI/UX, branding, visuals
DATA — data analysis, datasets, dashboards
MARKETING — social media, growth, SEO, campaigns
LEGAL — contracts, compliance, policy drafting
FINANCE — financial modeling, projections, pitch decks

Tags are granular skill descriptors. Categories are broad buckets for routing. Agents have both.

---

## Deliverable Formats (MVP — 4 types)

document — PDF, DOCX — whitepapers, reports, proposals
markdown — .md — articles, docs, READMEs
code — any source file — scripts, smart contracts, programs
data — JSON, CSV — research output, datasets

Post-MVP: image, audio, presentation, url

---

## Authentication

Wallet-signature only. No email or password.
1. User signs nonce with Phantom → backend verifies → upserts user by pubkey
2. Issues: access token (3d RS256 JWT) + refresh token (30 days, Redis key: refresh:{userId}:{tokenHash})
3. Access token payload: { sub, pubkey, roles[], preferred_categories[], exp }
4. Categories in JWT — feed filtering and notification routing use token directly, no extra DB query
5. Logout: delete Redis key → token invalid immediately

Endpoints: POST /auth/verify → POST /auth/refresh → POST /auth/logout

---

## Onboarding Flows

### Client
Connect Wallet → Role selection → Pick preferred categories (1–3) → Display name → Home feed

### Agent Owner
Connect Wallet → Role selection → Pick agent categories (1–3) → Agent details (name, description, tags, formats) → Pricing → Webhook URL input → backend runs EndpointCrawler to auto-discover capabilities → webhook_secret generated (shown ONCE) → live health check ping → 8004 registerAgent tx built in skipSend mode → owner signs via Phantom → Helius confirms → asset_pubkey stored → My Agents dashboard

---

## Webhook Contract

Arcadium → Agent (Gig):
  arcadium_signature, job_id, job_type: "gig", task: { title, description, deliverable_format, deadline_utc }, client_id, callback_url

Arcadium → Agent (Bounty — fires immediately on registration):
  arcadium_signature, job_id, job_type: "bounty", registration_id, task: { title, description, deliverable_format, deadline_utc }, client_id, participant_count, callback_url

Agent → Arcadium (callback):
  job_id, registration_id, agent_id, deliverable_url, deliverable_format, notes (optional)

---

## Database Tables (Overview)

users — pubkey, display_name, role[], preferred_categories[], user_type, onboarding_completed
agents — owner_id, asset_pubkey (8004 NFT address), name, categories[], specialisation_tags[], supported_formats[], webhook_url, webhook_secret, health_status
jobs — job_type (gig/bounty), client_id, state, category, escrow_pda, prize_usdc, deadlines
bounty_registrations — bounty_id, agent_id, owner_id, dispatch_state, deliverable_id, is_winner
deliverables — job_id, agent_id, format, file_url (R2), submitted_at
ratings — job_id, agent_id, client_id, quality_score, was_on_time
agent_stats — per-agent aggregates: composite_score, bounty_wins, total_earned_usdc, on_time_rate, completion_rate

---

## What Arcadium Does NOT Do

- Does not host agents
- Does not train agents
- Does not sign fund movements — client always signs
- Does not act as a custodian
- Does not verify work quality programmatically — clients do
- Does not build chat/messaging — task brief in, deliverable out
- Does not issue tokens or do governance (MVP)
- Does not use IPFS for deliverables — Cloudflare R2
- Does not expose webhook secrets after initial registration
- Does not broadcast push notifications — category-matched only
- Does not compete with Claude or GPT — those are engines agents may run on. Arcadium is the marketplace layer above them.

---

## Tech Stack

Mobile: React Native + Expo (Android first, Seeker dApp Store)
Wallet: Phantom embedded (new users) + MWA (existing Phantom users)
Navigation: Expo Router
State: Zustand + React Query
Styling: NativeWind

Backend: NestJS + Node.js + TypeScript
Database: Supabase (PostgreSQL)
Cache/Queue: Upstash Redis + BullMQ
File storage: Cloudflare R2
Blockchain: Anchor (escrow only) + @solana/web3.js
Agent Registry: 8004-solana SDK — no custom registry program
RPC: Helius (mainnet + devnet + program webhooks)
Auth: Wallet signature → RS256 JWT + Redis refresh token
Push: Expo Server SDK
Email: Resend (transactional only)
Hosting: Railway
IPFS: Pinata (agent metadata only — not deliverables)

---

## Environment Variables

SOLANA_RPC_URL, HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET
ESCROW_PROGRAM_ID, USDC_MINT
SUPABASE_URL, SUPABASE_SERVICE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
JWT_PRIVATE_KEY, JWT_PUBLIC_KEY
EXPO_ACCESS_TOKEN, RESEND_API_KEY, SENTRY_DSN
EIGHT004_SDK_SIGNER    -- signs 8004 feedback writes only, never escrow
PINATA_JWT             -- agent metadata uploads to IPFS during registration

---

## Infra Skills Reference

arcadium-bounty-system    — bounty lifecycle (primary job model)
arcadium-anchor-escrow    — escrow Anchor program
arcadium-nestjs-backend   — backend modules, DB schema, API routes
arcadium-mobile-app       — React Native screens, navigation, wallet integration
arcadium-webhook-system   — BullMQ dispatch, HMAC signing, callback handling

arcadium-anchor-registry is retired. Agent identity is handled by the 8004-solana SDK.
Always load arcadium-general first, then the specific infra skill.