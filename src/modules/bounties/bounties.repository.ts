import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BountyEntity } from '../../common/entities/bounty.entity';

/**
 * Data-access layer for the `bounties` table in Supabase.
 * All methods cast raw Supabase results to BountyEntity so callers can
 * reference strongly-typed fields instead of Record<string, unknown>.
 */
@Injectable()
export class BountiesRepository {
  private readonly logger = new Logger(BountiesRepository.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /** Inserts a new bounty record and returns the created row. */
  async create(data: Record<string, unknown>): Promise<BountyEntity> {
    const { data: bounty, error } = await this.supabase
      .from('bounties')
      .insert(data)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return bounty as BountyEntity;
  }

  /** Fetches a single bounty by its internal UUID. Throws on DB error. */
  async findById(id: string): Promise<BountyEntity> {
    const { data, error } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    const [submissionCounts, registrationCounts] = await Promise.all([
      this.fetchSubmissionCounts([id]),
      this.fetchRegistrationCounts([id]),
    ]);
    return {
      ...(data as BountyEntity),
      submission_count: submissionCounts[id] ?? 0,
      registration_count: registrationCounts[id] ?? 0,
    };
  }

  /**
   * Finds a bounty by its on-chain job ID bytes.
   * Used by the Helius webhook handler to correlate on-chain escrow events
   * back to the correct bounty record.
   */
  async findByJobId(jobIdBytes: Buffer): Promise<BountyEntity> {
    const { data, error } = await this.supabase
      .from('bounties')
      .select('*')
      /* Supabase integer[] column requires a plain JS array, not a Buffer */
      .eq('job_id_bytes', Array.from(jobIdBytes))
      .single();
    if (error) throw new Error(error.message);
    return data as BountyEntity;
  }

  /**
   * Returns bounties matching optional filters.
   * Defaults to state='open' when no state filter is provided.
   * The sort parameter is reserved for future use.
   */
  async browse(filters: {
    category?: string;
    state?: string;
    sort?: string;
  }): Promise<BountyEntity[]> {
    let query = this.supabase.from('bounties').select('*');
    if (filters.category) query = query.eq('category', filters.category);
    if (filters.state) query = query.eq('state', filters.state);
    else query = query.eq('state', 'open');
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const bounties = (data ?? []) as BountyEntity[];
    if (bounties.length === 0) return bounties;
    const ids = bounties.map((b) => b.id);
    const [submissionCounts, registrationCounts] = await Promise.all([
      this.fetchSubmissionCounts(ids),
      this.fetchRegistrationCounts(ids),
    ]);
    return bounties.map((b) => ({
      ...b,
      submission_count: submissionCounts[b.id] ?? 0,
      registration_count: registrationCounts[b.id] ?? 0,
    }));
  }

  /** Updates specified columns for a bounty and returns the updated row. */
  async update(id: string, updates: Record<string, unknown>): Promise<BountyEntity> {
    const { data, error } = await this.supabase
      .from('bounties')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data as BountyEntity;
  }

  /**
   * Returns open bounties whose submission_deadline has already passed.
   * Used by the scheduler to move them to under_review or auto-refund.
   */
  async findExpiredOpen(now: Date): Promise<BountyEntity[]> {
    const { data, error } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('state', 'open')
      .lt('submission_deadline', now.toISOString());
    if (error) throw new Error(error.message);
    return (data ?? []) as BountyEntity[];
  }

  /**
   * Returns under_review bounties whose review_deadline has already passed.
   * Used by the scheduler to auto-refund when no winner was selected in time.
   */
  async findExpiredReview(now: Date): Promise<BountyEntity[]> {
    const { data, error } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('state', 'under_review')
      .lt('review_deadline', now.toISOString());
    if (error) throw new Error(error.message);
    return (data ?? []) as BountyEntity[];
  }

  /**
   * Fetches submission counts for a list of bounty IDs in a single query.
   * Counts only registrations where deliverable_id IS NOT NULL (i.e. submitted work).
   * Returns a map of bounty_id → count.
   */
  private async fetchSubmissionCounts(
    bountyIds: string[],
  ): Promise<Record<string, number>> {
    const { data, error } = await this.supabase
      .from('bounty_registrations')
      .select('bounty_id')
      .in('bounty_id', bountyIds)
      .not('deliverable_id', 'is', null);
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      const id = (row as { bounty_id: string }).bounty_id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Fetches total registration counts for a list of bounty IDs in a single query.
   * Counts all registrations regardless of submission status.
   * Returns a map of bounty_id → count.
   */
  private async fetchRegistrationCounts(
    bountyIds: string[],
  ): Promise<Record<string, number>> {
    const { data, error } = await this.supabase
      .from('bounty_registrations')
      .select('bounty_id')
      .in('bounty_id', bountyIds);
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      const id = (row as { bounty_id: string }).bounty_id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }
}
