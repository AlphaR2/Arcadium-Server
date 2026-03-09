import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AgentStatsEntity } from '../../common/entities/agent-stats.entity';
import { OwnerStatsEntity } from '../../common/entities/owner-stats.entity';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { AtomService } from './atom.service';

// ── Composite score weights (must sum to 1.0) ─────────────────────────────────
const COMPOSITE_WEIGHTS = {
  avgQuality:    0.4,
  onTimeRate:    0.2,
  completionRate: 0.2,
  bountyWinRate: 0.2,
};

// ── Agent tier thresholds (checked in descending order) ───────────────────────
const AGENT_TIER_THRESHOLDS = [
  { tier: 'platinum', minScore: 0.7 },
  { tier: 'gold',     minScore: 0.5 },
  { tier: 'silver',   minScore: 0.3 },
  { tier: 'bronze',   minScore: 0.1 },
];

// ── Owner tier thresholds by XP ───────────────────────────────────────────────
const OWNER_TIER_THRESHOLDS = [
  { tier: 'platinum', minXp: 2000 },
  { tier: 'gold',     minXp:  800 },
  { tier: 'silver',   minXp:  200 },
  { tier: 'bronze',   minXp:   50 },
];

// ── XP awards per event ───────────────────────────────────────────────────────
const XP = {
  /** Agent registered for a bounty */
  register:     5,
  /** Agent submitted a deliverable */
  submit:       15,
  /** Deliverable was submitted before the deadline */
  onTimeBonus:  20,
  /** Agent won the bounty */
  win:          100,
  /** Bonus at a 3-win streak */
  streak3:      150,
  /** Bonus at a 5-win streak */
  streak5:      300,
  /** Bonus at a 10-win streak */
  streak10:     500,
  /** Client posted a bounty (went open) */
  ownerPost:    10,
  /** Client settled a bounty (selected winner) */
  ownerSettle:  25,
  /** Client submitted a quality rating */
  ownerRate:    15,
} as const;

// ── Pure helper: derive agent tier from composite score + wins ─────────────────
function deriveAgentTier(compositeScore: number, bountyWins: number): string {
  if (bountyWins === 0) return 'unranked';
  for (const { tier, minScore } of AGENT_TIER_THRESHOLDS) {
    if (compositeScore >= minScore) return tier;
  }
  return 'bronze';
}

// ── Pure helper: derive owner tier from accumulated XP ────────────────────────
function deriveOwnerTier(xpPoints: number): string {
  for (const { tier, minXp } of OWNER_TIER_THRESHOLDS) {
    if (xpPoints >= minXp) return tier;
  }
  return 'client';
}

// ── Pure helper: compute earned agent badges from stats ───────────────────────
function computeAgentBadges(s: Partial<AgentStatsEntity>): string[] {
  const badges: string[] = [];
  const wins = s.bounty_wins ?? 0;
  const subs = s.total_submissions ?? 0;
  const regs = s.total_registrations ?? 0;

  if (wins >= 1)  badges.push('first_win');
  if (wins >= 3)  badges.push('hat_trick');
  if (wins >= 10) badges.push('veteran');
  if ((s.on_time_rate ?? 0) >= 0.95 && subs >= 5)   badges.push('speed_demon');
  if ((s.completion_rate ?? 0) >= 0.9 && regs >= 10) badges.push('consistent');
  if ((s.avg_quality_rating ?? 0) >= 4.8 && subs >= 3) badges.push('five_star');
  return badges;
}

// ── Pure helper: compute earned owner badges from stats ───────────────────────
function computeOwnerBadges(s: Partial<OwnerStatsEntity>): string[] {
  const badges: string[] = [];
  if ((s.bounties_posted ?? 0) >= 10)      badges.push('active_client');
  if ((s.total_usdc_awarded ?? 0) >= 1000) badges.push('big_spender');
  if ((s.ratings_given ?? 0) >= 10)        badges.push('great_reviewer');
  return badges;
}

/**
 * Central reputation service — owns all XP, tier, badge, and leaderboard logic.
 *
 * Called from:
 *   BountiesRegistrationService → incrementAgentRegistration  (on agent register)
 *   DeliverablesService         → incrementAgentSubmission    (on deliverable stored)
 *   BountiesReviewService       → handleBountyCompleted       (on winner selected)
 *   BountiesReviewService       → handleOwnerBountySettled    (on winner selected)
 *   BountiesService             → handleOwnerBountyPosted     (on escrow confirmed)
 *   ReputationService (self)    → handleOwnerRatingGiven      (inside submitRating)
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);
  private readonly supabase: SupabaseClient;

  /**
   * Upstash REST Redis — three ZSET leaderboard namespaces:
   *   leaderboard:global             all-time across all categories
   *   leaderboard:monthly:{YYYY-MM}  current calendar month
   *   leaderboard:category:{slug}    per-category all-time
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
      url:   this.config.get<string>('redis.restUrl')   ?? '',
      token: this.config.get<string>('redis.restToken') ?? '',
    });
  }

  // ── Agent events ─────────────────────────────────────────────────────────────

  /**
   * Called when an agent registers for a bounty.
   * Increments total_registrations and awards XP +5.
   */
  async incrementAgentRegistration(agentId: string): Promise<void> {
    this.logger.log(`incrementAgentRegistration agentId=${agentId}`);
    const s = await this.loadAgentStats(agentId);
    await this.supabase.from('agent_stats').upsert(
      {
        agent_id:            agentId,
        total_registrations: (s.total_registrations ?? 0) + 1,
        xp_points:           (s.xp_points ?? 0) + XP.register,
      },
      { onConflict: 'agent_id' },
    );
  }

  /**
   * Called after a deliverable is successfully stored.
   * Increments total_submissions and on_time_submissions.
   * Recalculates completion_rate and on_time_rate.
   * Awards XP +15 base, +20 on-time bonus.
   * Triggers composite score recalculation and leaderboard push.
   */
  async incrementAgentSubmission(agentId: string, wasOnTime: boolean): Promise<void> {
    this.logger.log(`incrementAgentSubmission agentId=${agentId} onTime=${wasOnTime}`);
    const s = await this.loadAgentStats(agentId);

    const totalSubs   = (s.total_submissions    ?? 0) + 1;
    const onTimeSubs  = (s.on_time_submissions   ?? 0) + (wasOnTime ? 1 : 0);
    /* Fall back to totalSubs if registrations not yet tracked — keeps rate ≤ 1 */
    const totalRegs   = Math.max(s.total_registrations ?? 0, totalSubs);
    const completionRate = totalSubs / totalRegs;
    const onTimeRate     = totalSubs > 0 ? onTimeSubs / totalSubs : 0;
    const xpGain         = XP.submit + (wasOnTime ? XP.onTimeBonus : 0);

    await this.supabase.from('agent_stats').upsert(
      {
        agent_id:            agentId,
        total_submissions:   totalSubs,
        on_time_submissions: onTimeSubs,
        completion_rate:     completionRate,
        on_time_rate:        onTimeRate,
        xp_points:           (s.xp_points ?? 0) + xpGain,
      },
      { onConflict: 'agent_id' },
    );

    await this.recalculateCompositeScore(agentId);
  }

  /**
   * Called after a bounty is settled and a winner is selected.
   * Increments bounty_wins, total_earned_usdc, and win_streak.
   * Recalculates bounty_win_rate.
   * Awards XP +100 win, plus streak bonuses at 3 / 5 / 10.
   * Triggers composite score recalculation, tier update, and leaderboard push.
   * Also writes ATOM Tag.successRate on-chain for the winner.
   */
  async handleBountyCompleted(bounty: BountyEntity): Promise<void> {
    this.logger.log(`handleBountyCompleted bounty=${bounty.id}`);
    const winnerAgentId = bounty.winner_agent_id;
    if (!winnerAgentId) return;

    const s         = await this.loadAgentStats(winnerAgentId);
    const prizeUsdc = bounty.prize_usdc ?? 0;
    const wins      = (s.bounty_wins ?? 0) + 1;
    const totalRegs = Math.max(s.total_registrations ?? 0, wins);
    const winRate   = wins / totalRegs;
    const newStreak = (s.win_streak ?? 0) + 1;

    /* Streak milestone bonus — only the milestone tick awards the bonus */
    let streakBonus = 0;
    if (newStreak === 10)      streakBonus = XP.streak10;
    else if (newStreak === 5)  streakBonus = XP.streak5;
    else if (newStreak === 3)  streakBonus = XP.streak3;

    await this.supabase.from('agent_stats').upsert(
      {
        agent_id:          winnerAgentId,
        bounty_wins:       wins,
        total_earned_usdc: (s.total_earned_usdc ?? 0) + prizeUsdc * 0.9,
        bounty_win_rate:   winRate,
        win_streak:        newStreak,
        xp_points:         (s.xp_points ?? 0) + XP.win + streakBonus,
      },
      { onConflict: 'agent_id' },
    );

    /* Recalculate composite + tier + badges + leaderboard */
    await this.recalculateCompositeScore(winnerAgentId);

    /* ATOM on-chain successRate tag */
    await this.atomService.writeBountyFeedback(bounty as unknown as Record<string, unknown>);
  }

  // ── Owner events ─────────────────────────────────────────────────────────────

  /**
   * Called when a bounty transitions to 'open' (escrow confirmed).
   * Increments bounties_posted and awards owner XP +10.
   */
  async handleOwnerBountyPosted(ownerId: string): Promise<void> {
    this.logger.log(`handleOwnerBountyPosted ownerId=${ownerId}`);
    const s      = await this.loadOwnerStats(ownerId);
    const posted = (s.bounties_posted ?? 0) + 1;
    const xp     = (s.xp_points ?? 0) + XP.ownerPost;
    const merged: Partial<OwnerStatsEntity> = { ...s, bounties_posted: posted, xp_points: xp };
    const badges = computeOwnerBadges(merged);
    const tier   = deriveOwnerTier(xp);

    await this.supabase.from('owner_stats').upsert(
      { owner_id: ownerId, bounties_posted: posted, xp_points: xp, tier, badges },
      { onConflict: 'owner_id' },
    );
  }

  /**
   * Called after a winner is selected and escrow settled.
   * Increments bounties_settled + total_usdc_awarded, awards owner XP +25.
   */
  async handleOwnerBountySettled(ownerId: string, prizeUsdc: number): Promise<void> {
    this.logger.log(`handleOwnerBountySettled ownerId=${ownerId} prize=${prizeUsdc}`);
    const s       = await this.loadOwnerStats(ownerId);
    const settled = (s.bounties_settled    ?? 0) + 1;
    const usdc    = (s.total_usdc_awarded  ?? 0) + prizeUsdc;
    const xp      = (s.xp_points          ?? 0) + XP.ownerSettle;
    const merged: Partial<OwnerStatsEntity> = {
      ...s, bounties_settled: settled, total_usdc_awarded: usdc, xp_points: xp,
    };
    const badges = computeOwnerBadges(merged);
    const tier   = deriveOwnerTier(xp);

    await this.supabase.from('owner_stats').upsert(
      {
        owner_id:          ownerId,
        bounties_settled:  settled,
        total_usdc_awarded: usdc,
        xp_points:         xp,
        tier,
        badges,
      },
      { onConflict: 'owner_id' },
    );
  }

  /**
   * Called after a client submits a quality rating for a winning agent.
   * Increments ratings_given and awards owner XP +15.
   * Private — called internally by submitRating().
   */
  private async handleOwnerRatingGiven(ownerId: string): Promise<void> {
    this.logger.log(`handleOwnerRatingGiven ownerId=${ownerId}`);
    const s      = await this.loadOwnerStats(ownerId);
    const given  = (s.ratings_given ?? 0) + 1;
    const xp     = (s.xp_points    ?? 0) + XP.ownerRate;
    const merged: Partial<OwnerStatsEntity> = { ...s, ratings_given: given, xp_points: xp };
    const badges = computeOwnerBadges(merged);
    const tier   = deriveOwnerTier(xp);

    await this.supabase.from('owner_stats').upsert(
      { owner_id: ownerId, ratings_given: given, xp_points: xp, tier, badges },
      { onConflict: 'owner_id' },
    );
  }

  // ── Composite score, leaderboards, tier, badges ───────────────────────────────

  /**
   * Reads latest agent_stats, applies the COMPOSITE_WEIGHTS formula, derives tier
   * and badges, writes back to Supabase, and pushes score to all Redis leaderboards.
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
      (s.on_time_rate        ?? 0) * COMPOSITE_WEIGHTS.onTimeRate +
      (s.completion_rate     ?? 0) * COMPOSITE_WEIGHTS.completionRate +
      (s.bounty_win_rate     ?? 0) * COMPOSITE_WEIGHTS.bountyWinRate;

    const tier   = deriveAgentTier(composite, s.bounty_wins ?? 0);
    const badges = computeAgentBadges(s);

    await this.supabase
      .from('agent_stats')
      .update({ composite_score: composite, tier, badges })
      .eq('agent_id', agentId);

    await this.updateRedisLeaderboard(agentId, composite);
  }

  /**
   * Updates all Redis ZSET leaderboards for an agent's new composite score.
   * Three ZSETs: global, current-month, and per-category.
   */
  async updateRedisLeaderboard(agentId: string, score: number): Promise<void> {
    const now   = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await Promise.all([
      this.redis.zadd('leaderboard:global', { score, member: agentId }),
      this.redis.zadd(`leaderboard:monthly:${month}`, { score, member: agentId }),
    ]);

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
   *   category provided → per-category leaderboard
   *   period='monthly'  → current-month leaderboard
   *   otherwise         → global all-time leaderboard
   */
  async getLeaderboard(category?: string, period?: string): Promise<unknown[]> {
    const now   = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let key: string;
    if (category) {
      key = `leaderboard:category:${category}`;
    } else if (period === 'monthly') {
      key = `leaderboard:monthly:${month}`;
    } else {
      key = 'leaderboard:global';
    }

    const entries = await this.redis.zrange(key, 0, 49, { rev: true, withScores: true });
    return entries ?? [];
  }

  // ── Stats getters ─────────────────────────────────────────────────────────────

  /** Returns the full agent_stats row for the given agent UUID. */
  async getAgentStats(agentId: string): Promise<AgentStatsEntity> {
    const { data } = await this.supabase
      .from('agent_stats')
      .select('*')
      .eq('agent_id', agentId)
      .single();
    return (data ?? {}) as AgentStatsEntity;
  }

  /** Returns the full owner_stats row for the given user UUID. */
  async getOwnerStats(ownerId: string): Promise<OwnerStatsEntity> {
    const { data } = await this.supabase
      .from('owner_stats')
      .select('*')
      .eq('owner_id', ownerId)
      .single();
    return (data ?? {}) as OwnerStatsEntity;
  }

  // ── Rating submission ─────────────────────────────────────────────────────────

  /**
   * Submits a quality rating for a winning agent's deliverable.
   *
   * Steps:
   *   1. Verify caller is the bounty client and bounty is settled.
   *   2. Verify the agent was the winner.
   *   3. Insert/upsert into ratings table.
   *   4. Recalculate avg_quality_rating from all ratings for that agent.
   *   5. Recalculate composite score + tier + badges + leaderboard.
   *   6. Write ATOM Tag.starred feedback with the quality score.
   *   7. Award owner XP +15 for leaving a rating.
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

    /* 2. Verify agent is the winner */
    if (bounty['winner_agent_id'] !== dto.agentId) {
      throw new BadRequestException('Ratings can only be submitted for the winning agent');
    }

    /* 3. Insert rating — upsert to allow updating if called twice */
    const { error } = await this.supabase.from('ratings').upsert(
      {
        bounty_id:    bountyId,
        agent_id:     dto.agentId,
        client_id:    clientId,
        quality_score: dto.qualityScore,
        was_on_time:  dto.wasOnTime,
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
      { agent_id: dto.agentId, avg_quality_rating: avgQuality },
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

    /* 7. Award owner XP for leaving a rating */
    await this.handleOwnerRatingGiven(clientId);

    this.logger.log(
      `Rating submitted: bounty=${bountyId} agent=${dto.agentId} score=${dto.qualityScore}`,
    );
    return { ok: true };
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async loadAgentStats(agentId: string): Promise<Partial<AgentStatsEntity>> {
    const { data } = await this.supabase
      .from('agent_stats')
      .select('*')
      .eq('agent_id', agentId)
      .maybeSingle();
    return (data as Partial<AgentStatsEntity>) ?? {};
  }

  private async loadOwnerStats(ownerId: string): Promise<Partial<OwnerStatsEntity>> {
    const { data } = await this.supabase
      .from('owner_stats')
      .select('*')
      .eq('owner_id', ownerId)
      .maybeSingle();
    return (data as Partial<OwnerStatsEntity>) ?? {};
  }
}
