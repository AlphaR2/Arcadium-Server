import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AgentStatsEntity } from '../../common/entities/agent-stats.entity';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { AtomService } from './atom.service';
import { Tag } from '8004-solana';

/**
 * Weights used to compute the composite reputation score from agent_stats columns.
 * Must sum to 1.0.
 */
const COMPOSITE_WEIGHTS = {
  avgQuality: 0.4,
  onTimeRate: 0.2,
  completionRate: 0.2,
  bountyWinRate: 0.2,
};

/**
 * Manages agent reputation: updates stats after bounty completion,
 * recalculates composite scores, and maintains Redis leaderboards.
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);
  private readonly supabase: SupabaseClient;

  /**
   * Upstash REST Redis client — used for ZSET leaderboards.
   * Three leaderboard namespaces are maintained:
   *   leaderboard:global             — all-time across all categories
   *   leaderboard:monthly:{YYYY-MM}  — current calendar month
   *   leaderboard:category:{slug}    — per-category all-time
   */
  private readonly redis: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly atomService: AtomService,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
    this.redis = new Redis({
      url: this.config.get<string>('redis.restUrl') ?? '',
      token: this.config.get<string>('redis.restToken') ?? '',
    });
  }

  /**
   * Called after a bounty is settled (winner selected and funds released).
   * Increments the winner's bounty_wins and total_earned_usdc counters,
   * then triggers a composite score recalculation and leaderboard update.
   *
   * The platform takes a 10% fee — only 90% of prize_usdc is credited to the agent.
   */
  async handleBountyCompleted(bounty: BountyEntity): Promise<void> {
    this.logger.log(`handleBountyCompleted bounty=${bounty.id}`);

    const winnerAgentId = bounty.winner_agent_id;
    if (!winnerAgentId) return;

    /* Load existing stats for the winner (may not exist on first win) */
    const { data: winnerStats } = await this.supabase
      .from('agent_stats')
      .select('*')
      .eq('agent_id', winnerAgentId)
      .single();

    const ws = (winnerStats as AgentStatsEntity | null) ?? ({} as AgentStatsEntity);
    const prizeUsdc = bounty.prize_usdc ?? 0;

    /* Upsert winner stats — increment wins and net earnings */
    await this.supabase.from('agent_stats').upsert(
      {
        agent_id: winnerAgentId,
        bounty_wins: (ws.bounty_wins ?? 0) + 1,
        /* 90% of prize after platform fee */
        total_earned_usdc: (ws.total_earned_usdc ?? 0) + prizeUsdc * 0.9,
      },
      { onConflict: 'agent_id' },
    );

    /* Recalculate composite score and push to Redis leaderboards */
    await this.recalculateCompositeScore(winnerAgentId);
  }

  /**
   * Reads the latest agent_stats row for an agent, applies the COMPOSITE_WEIGHTS formula,
   * writes the result back to Supabase, and pushes the score to all Redis leaderboards.
   *
   * Formula:
   *   composite = (avg_quality_rating * 0.4)
   *             + (on_time_rate       * 0.2)
   *             + (completion_rate    * 0.2)
   *             + (bounty_win_rate    * 0.2)
   */
  async recalculateCompositeScore(agentId: string): Promise<void> {
    const { data: stats } = await this.supabase
      .from('agent_stats')
      .select('*')
      .eq('agent_id', agentId)
      .single();

    if (!stats) return;

    const s = stats as AgentStatsEntity;
    const composite =
      (s.avg_quality_rating ?? 0) * COMPOSITE_WEIGHTS.avgQuality +
      (s.on_time_rate ?? 0) * COMPOSITE_WEIGHTS.onTimeRate +
      (s.completion_rate ?? 0) * COMPOSITE_WEIGHTS.completionRate +
      (s.bounty_win_rate ?? 0) * COMPOSITE_WEIGHTS.bountyWinRate;

    /* Persist updated composite score to Supabase */
    await this.supabase
      .from('agent_stats')
      .update({ composite_score: composite })
      .eq('agent_id', agentId);

    /* Push to Redis leaderboards */
    await this.updateRedisLeaderboard(agentId, composite);
  }

  /**
   * Updates all Redis ZSET leaderboards for an agent's new composite score.
   * Three ZSETs are maintained: global, current-month, and per-category.
   * Leaderboards serve the GET /reputation/leaderboard endpoint.
   */
  async updateRedisLeaderboard(agentId: string, score: number): Promise<void> {
    const now = new Date();
    /* Month key format: YYYY-MM (e.g. 2025-08) */
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    /* Update global and monthly leaderboards in parallel */
    await Promise.all([
      this.redis.zadd('leaderboard:global', { score, member: agentId }),
      this.redis.zadd(`leaderboard:monthly:${month}`, { score, member: agentId }),
    ]);

    /* Update per-category leaderboards — fetch the agent's categories from Supabase */
    const { data: agent } = await this.supabase
      .from('agents')
      .select('categories')
      .eq('id', agentId)
      .single();

    if (agent) {
      const categories = (agent as { categories?: string[] }).categories ?? [];
      for (const cat of categories) {
        await this.redis.zadd(`leaderboard:category:${cat}`, { score, member: agentId });
      }
    }
  }

  /**
   * Queries the appropriate Redis ZSET and returns up to 50 entries
   * sorted by composite score descending.
   *
   * Key selection:
   *   category provided → category leaderboard
   *   period='monthly'  → current-month leaderboard
   *   otherwise         → global all-time leaderboard
   */
  async getLeaderboard(category?: string, period?: string): Promise<unknown[]> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let key: string;
    if (category) {
      key = `leaderboard:category:${category}`;
    } else if (period === 'monthly') {
      key = `leaderboard:monthly:${month}`;
    } else {
      key = 'leaderboard:global';
    }

    /* zrange with rev=true and withScores=true returns alternating member/score pairs */
    const entries = await this.redis.zrange(key, 0, 49, { rev: true, withScores: true });
    return entries ?? [];
  }

  /** Returns the full agent_stats row for the given agent UUID. */
  async getAgentStats(agentId: string): Promise<AgentStatsEntity> {
    const { data } = await this.supabase
      .from('agent_stats')
      .select('*')
      .eq('agent_id', agentId)
      .single();
    return (data ?? {}) as AgentStatsEntity;
  }

  /**
   * Submits a quality rating for a winning agent's deliverable.
   *
   * Steps:
   *   1. Verify caller is the bounty client and bounty is settled.
   *   2. Verify the agent was the winner (or at least a registered participant).
   *   3. Insert into ratings table.
   *   4. Recalculate avg_quality_rating from all ratings for that agent.
   *   5. Recalculate composite score + push to Redis leaderboards.
   *   6. Write ATOM Tag.starred feedback with the actual quality score.
   */
  async submitRating(
    bountyId: string,
    clientId: string,
    dto: { agentId: string; qualityScore: number; wasOnTime: boolean },
  ): Promise<{ ok: boolean }> {
    /* 1. Load bounty and verify caller */
    const { data: bountyRow } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .single();

    if (!bountyRow) throw new NotFoundException('Bounty not found');

    const bounty = bountyRow as Record<string, unknown>;

    if (bounty['client_id'] !== clientId) {
      throw new BadRequestException('Only the bounty client can submit a rating');
    }

    if (bounty['state'] !== 'settled' && bounty['state'] !== 'completed') {
      throw new BadRequestException('Ratings can only be submitted after the bounty is settled');
    }

    /* 2. Verify the agent is the winner */
    if (bounty['winner_agent_id'] !== dto.agentId) {
      throw new BadRequestException('Ratings can only be submitted for the winning agent');
    }

    /* 3. Insert rating — upsert to allow updating if called twice */
    const { error } = await this.supabase.from('ratings').upsert(
      {
        bounty_id: bountyId,
        agent_id: dto.agentId,
        client_id: clientId,
        quality_score: dto.qualityScore,
        was_on_time: dto.wasOnTime,
      },
      { onConflict: 'bounty_id,agent_id' },
    );

    if (error) throw new BadRequestException(`Failed to save rating: ${error.message}`);

    /* 4. Recalculate avg_quality_rating from all historical ratings for this agent */
    const { data: ratingRows } = await this.supabase
      .from('ratings')
      .select('quality_score')
      .eq('agent_id', dto.agentId);

    const scores = (ratingRows ?? []) as Array<{ quality_score: number }>;
    const avgQuality =
      scores.length > 0
        ? scores.reduce((sum, r) => sum + r.quality_score, 0) / scores.length
        : dto.qualityScore;

    await this.supabase.from('agent_stats').upsert(
      {
        agent_id: dto.agentId,
        avg_quality_rating: avgQuality,
      },
      { onConflict: 'agent_id' },
    );

    /* 5. Recalculate composite score + leaderboard */
    await this.recalculateCompositeScore(dto.agentId);

    /* 6. Write ATOM Tag.starred with the actual client quality score */
    const { data: agentRow } = await this.supabase
      .from('agents')
      .select('asset_pubkey')
      .eq('id', dto.agentId)
      .single();

    if (agentRow) {
      const assetPubkey = (agentRow as Record<string, unknown>)['asset_pubkey'] as string | null;
      if (assetPubkey) {
        try {
          await this.atomService.writeRatingFeedback(assetPubkey, dto.qualityScore);
        } catch (err) {
          this.logger.warn(`ATOM starred feedback failed for ${dto.agentId}: ${String(err)}`);
        }
      }
    }

    this.logger.log(`Rating submitted: bounty=${bountyId} agent=${dto.agentId} score=${dto.qualityScore}`);
    return { ok: true };
  }
}
