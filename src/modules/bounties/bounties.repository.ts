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
    return data as BountyEntity;
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
    return (data ?? []) as BountyEntity[];
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
}
