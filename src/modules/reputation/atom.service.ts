import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SolanaSDK, Tag } from '8004-solana';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class AtomService {
  private readonly logger = new Logger(AtomService.name);
  private readonly sdk: SolanaSDK;
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const rawKey = this.config.get<string>('authority.privateKey') ?? '[]';
    const signer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(rawKey) as number[]),
    );

    this.sdk = new SolanaSDK({
      cluster: 'devnet',
      rpcUrl: this.config.get<string>('solana.rpcUrl'),
      signer,
    });

    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Writes 8004 ATOM feedback after bounty winner is selected.
   * Writes Tag.successRate for the winner's agent.
   */
  async writeBountyFeedback(bounty: Record<string, unknown>): Promise<void> {
    this.logger.log(`writeBountyFeedback bounty=${bounty['id']}`);

    const winnerAgentId = bounty['winner_agent_id'] as string | null;
    if (!winnerAgentId) return;

    const { data: agent } = await this.supabase
      .from('agents')
      .select('asset_pubkey')
      .eq('id', winnerAgentId)
      .single();

    if (!agent) return;

    const assetPubkey = (agent as Record<string, unknown>)[
      'asset_pubkey'
    ] as string;
    if (!assetPubkey) {
      this.logger.warn(`Agent ${winnerAgentId} has no asset_pubkey, skipping`);
      return;
    }

    try {
      await this.sdk.giveFeedback(new PublicKey(assetPubkey), {
        value: '100',
        tag1: Tag.successRate,
        score: 100,
      });
      this.logger.log(`ATOM successRate written for agent ${winnerAgentId}`);
    } catch (err) {
      this.logger.error(`ATOM feedback failed for ${winnerAgentId}`, err);
    }
  }

  /**
   * Writes health check feedback (reachable + uptime) after a health check.
   */
  async writeHealthFeedback(
    agentId: string,
    status: 'live' | 'partially' | 'not_live',
    uptimePercent: number,
  ): Promise<void> {
    this.logger.log(`writeHealthFeedback agentId=${agentId} status=${status}`);

    const { data: agent } = await this.supabase
      .from('agents')
      .select('asset_pubkey')
      .eq('id', agentId)
      .single();

    if (!agent) return;

    const assetPubkey = (agent as Record<string, unknown>)[
      'asset_pubkey'
    ] as string;
    if (!assetPubkey) return;

    try {
      const reachableValue = status === 'live' ? 1 : 0;
      const reachableScore = status === 'live' ? 100 : 0;

      await this.sdk.giveFeedback(new PublicKey(assetPubkey), {
        value: reachableValue,
        valueDecimals: 0,
        tag1: Tag.reachable,
        score: reachableScore,
      });

      if (uptimePercent > 0) {
        await this.sdk.giveFeedback(new PublicKey(assetPubkey), {
          value: uptimePercent.toFixed(2),
          tag1: Tag.uptime,
          tag2: Tag.day,
        });
      }

      this.logger.log(`ATOM health feedback written for agent ${agentId}`);
    } catch (err) {
      this.logger.error(`ATOM health feedback failed for ${agentId}`, err);
    }
  }

  /**
   * Writes Tag.starred feedback with the client's actual quality score.
   * Called from ReputationService.submitRating() after the client rates a deliverable.
   * This provides a more accurate ATOM signal than the default 100 written at settlement.
   */
  async writeRatingFeedback(assetPubkey: string, qualityScore: number): Promise<void> {
    this.logger.log(`writeRatingFeedback assetPubkey=${assetPubkey} score=${qualityScore}`);
    await this.sdk.giveFeedback(new PublicKey(assetPubkey), {
      value: String(qualityScore),
      tag1: Tag.starred,
      score: qualityScore,
    });
    this.logger.log(`ATOM starred feedback written: assetPubkey=${assetPubkey}`);
  }
}
