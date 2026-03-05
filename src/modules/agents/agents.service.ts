import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsRepository } from './agents.repository';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentEntity } from '../../common/entities/agent.entity';
import {
  AgentRegistrationResponse,
  ConfirmRegistrationResponse,
  HealthCheckResponse,
} from '../../common/interfaces';
import {
  SolanaSDK,
  IPFSClient,
  buildRegistrationFileJson,
  ServiceType,
  EndpointCrawler,
} from '8004-solana';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as crypto from 'crypto';

/**
 * Business logic for agent management.
 * Handles registration (8004 NFT), health checks, and CRUD operations.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  /** 8004 Solana SDK — used for registration tx building and health checks. */
  private readonly sdk: SolanaSDK;

  /** IPFS client — used to pin Open Agentic Schema Framwork (OASF) metadata JSON during registration. */
  private readonly ipfs: IPFSClient;

  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly config: ConfigService,
  ) {
    const rpcUrl = this.config.get<string>('solana.rpcUrl');
    const pinataJwt = this.config.get<string>('pinataJwt');

    this.sdk = new SolanaSDK({
      cluster: 'devnet',
      rpcUrl,
    });

    this.ipfs = new IPFSClient({
      pinataEnabled: true,
      pinataJwt: pinataJwt ?? '',
    });
  }

  /**
   * Full agent onboarding flow:
   *   1. Attempt to crawl MCP capabilities from the agent's webhook URL
   *   2. Build OASF-compliant metadata JSON (name, description, services, skills, domains)
   *   3. Pin metadata to IPFS via Pinata and form an ipfs:// token URI
   *   4. Generate a deterministic asset keypair (so we know the NFT address before broadcasting)
   *   5. Build an unsigned 8004 registerAgent tx (skipSend mode) for Phantom to sign
   *   6. Generate a random HMAC webhook secret for this agent
   *   7. Persist a pending agent record in the DB
   *   8. Store the pending asset pubkey so Helius can match the on-chain event later
   *
   * Returns the unsigned tx, webhook secret, and asset pubkey for the mobile client.
   */
  async registerAgent(
    dto: CreateAgentDto,
    ownerPubkey: string,
    ownerId: string,
  ): Promise<AgentRegistrationResponse> {
    this.logger.log(`registerAgent for owner ${ownerPubkey}`);

    /* Step 1: Try to crawl MCP capabilities — non-fatal on null return or throw */
    const crawler = new EndpointCrawler(8000);
    let mcpCapabilities: Record<string, unknown> = {};
    try {
      const mcp = await crawler.fetchMcpCapabilities(dto.webhookUrl);
      /* fetchMcpCapabilities returns null when the URL has no MCP endpoint — guard it */
      if (mcp) {
        mcpCapabilities = mcp as unknown as Record<string, unknown>;
      }
    } catch {
      this.logger.warn(`MCP capability crawl failed for ${dto.webhookUrl}, continuing`);
    }

    /* Step 2: Declare services — always A2A; add MCP if the crawler found tools */
    const services = [{ type: ServiceType.A2A, value: dto.webhookUrl }];
    if (mcpCapabilities['mcpTools']) {
      services.push({ type: ServiceType.MCP, value: dto.webhookUrl });
    }

    /*
     * Build OASF metadata JSON.
     * Fix: use dto.skills (OASF skills) and dto.domains (OASF domains) directly.
     * dto.specialisationTags maps to the DB `specialisation_tags` column, not OASF skills.
     */
    const metadata = buildRegistrationFileJson({
      name: dto.name,
      description: dto.description as string,
      services,
      skills: dto.skills ?? dto.specialisationTags ?? [],
      domains: dto.domains ?? (dto.categories as string[]) ?? [],
    });

    /* Step 3: Upload metadata to IPFS and form the token URI */
    const cid = await this.ipfs.addJson(metadata);
    const tokenUri = `ipfs://${cid}`;

    /* Step 4: Generate asset keypair — the public key is the future 8004 NFT address */
    const assetKeypair = Keypair.generate();
    const assetPubkey = assetKeypair.publicKey.toBase58();

    const ownerPubkeyObj = new PublicKey(ownerPubkey);

    /* Step 5: Build unsigned registerAgent tx in skipSend mode for Phantom */
    const prepared = await this.sdk.registerAgent(tokenUri, {
      skipSend: true,
      signer: ownerPubkeyObj,
      assetPubkey: assetKeypair.publicKey,
      atomEnabled: true,
    } as Parameters<typeof this.sdk.registerAgent>[1]);

    /* Step 6: Generate a 32-byte hex HMAC secret for webhook signature verification */
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    /* Step 7: Persist the pending agent record */
    const agent = await this.agentsRepository.create({
      owner_id: ownerId,
      name: dto.name,
      description: dto.description ?? null,
      categories: dto.categories ?? [],
      specialisation_tags: dto.specialisationTags ?? [],
      supported_formats: dto.supportedFormats ?? [],
      webhook_url: dto.webhookUrl,
      webhook_secret: webhookSecret,
      health_status: 'pending',
    });

    /* Step 8: Store the pending asset pubkey so Helius can match the confirmation event */
    await this.agentsRepository.setPendingAsset(agent.id, assetPubkey);

    this.logger.log(`Agent ${agent.id} created, pending asset ${assetPubkey}`);

    return {
      agentId: agent.id,
      /* The SDK returns the base64 transaction under the 'transaction' key */
      tx: (prepared as unknown as Record<string, string>)['transaction'] ?? '',
      webhookSecret,
      assetPubkey,
    };
  }

  /**
   * Checks whether the agent's 8004 NFT has been confirmed on-chain.
   * Called by the mobile app after the user broadcasts the registration tx via Phantom.
   * On confirmation, moves asset_pubkey from pending to confirmed and sets health to healthy.
   */
  async confirmRegistration(
    agentId: string,
    ownerId: string,
  ): Promise<ConfirmRegistrationResponse> {
    const agent = await this.agentsRepository.findById(agentId);
    if (!agent) throw new BadRequestException('Agent not found');

    /* Ownership guard — only the agent owner can confirm registration */
    if (agent.owner_id !== ownerId) throw new BadRequestException('Forbidden');

    const pendingPubkey = new PublicKey(agent.pending_asset_pubkey!);
    if (!pendingPubkey) return { confirmed: false };

    try {
      /* Query the 8004 SDK to verify the NFT exists on-chain */
      const exists = await this.sdk.agentExists(pendingPubkey);
      if (exists) {
        /* Promote from pending to confirmed — clear pending key, set final key */
        await this.agentsRepository.update(agentId, {
          asset_pubkey: pendingPubkey.toBase58(),
          pending_asset_pubkey: null,
          health_status: 'healthy',
        });
        return { confirmed: true, assetPubkey: pendingPubkey.toBase58() };
      }
    } catch (err) {
      this.logger.warn(`agentExists check failed: ${String(err)}`);
    }

    return { confirmed: false };
  }

  /** Returns all agents matching optional category and health status filters. */
  async browse(filters: { category?: string; healthStatus?: string }): Promise<AgentEntity[]> {
    return this.agentsRepository.browse(filters);
  }

  /** Returns a single agent by UUID. Throws if not found. */
  async findById(id: string): Promise<AgentEntity> {
    return this.agentsRepository.findById(id);
  }

  /** Returns all agents owned by the given user UUID, including pending ones. */
  async findByOwner(ownerId: string): Promise<AgentEntity[]> {
    return this.agentsRepository.findByOwnerId(ownerId);
  }

  /** Updates mutable agent fields. Only supplied DTO fields are written to the DB. */
  async update(id: string, dto: UpdateAgentDto): Promise<AgentEntity> {
    return this.agentsRepository.update(id, dto as Record<string, unknown>);
  }

  /**
   * Triggers a live health check for an agent using the 8004 SDK.
   * Updates health_status in the DB based on the result.
   * Returns 'unregistered' if the agent has no confirmed asset pubkey yet.
   */
  async triggerHealthCheck(agentId: string): Promise<HealthCheckResponse> {
    this.logger.log(`triggerHealthCheck for agent ${agentId}`);

    const agent = await this.agentsRepository.findById(agentId);
    if (!agent) throw new BadRequestException('Agent not found');

    /* Agent has no on-chain identity yet — cannot health-check */
    if (!agent.asset_pubkey) return { status: 'unregistered' };

    try {
      /* sdk.isItAlive returns { status: 'live' | 'partially' | 'not_live' } */
      const report = await this.sdk.isItAlive(new PublicKey(agent.asset_pubkey));
      const status =
        report.status === 'live'
          ? 'healthy'
          : report.status === 'partially'
            ? 'degraded'
            : 'unhealthy';

      await this.agentsRepository.update(agentId, { health_status: status });
      return { status };
    } catch (err) {
      this.logger.error(`Health check failed for ${agentId}`, err);
      throw new ServiceUnavailableException('Health check failed');
    }
  }
}
