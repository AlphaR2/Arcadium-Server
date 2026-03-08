import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AgentEntity } from '../../common/entities/agent.entity';

/**
 * Data-access layer for the `agents` table in Supabase.
 * All methods cast the raw Supabase result to AgentEntity so callers
 * can work with named fields instead of Record<string, unknown>.
 */
@Injectable()
export class AgentsRepository {
  private readonly logger = new Logger(AgentsRepository.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /** Inserts a new agent record and returns the created row. */
  async create(data: Record<string, unknown>): Promise<AgentEntity> {
    const { data: agent, error } = await this.supabase
      .from('agents')
      .insert(data)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return agent as AgentEntity;
  }

  /** Fetches a single agent by its internal UUID. Throws on DB error. */
  async findById(id: string): Promise<AgentEntity> {
    const { data, error } = await this.supabase
      .from('agents')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data as AgentEntity;
  }

  /** Returns all agents owned by the given user UUID. */
  async findByOwnerId(ownerId: string): Promise<AgentEntity[]> {
    const { data, error } = await this.supabase
      .from('agents')
      .select('*')
      .eq('owner_id', ownerId);
    if (error) throw new Error(error.message);
    return (data ?? []) as AgentEntity[];
  }

  /**
   * Looks up an agent by its PENDING asset public key (before on-chain confirmation).
   * Used by the Helius webhook handler to match a newly minted 8004 NFT back to
   * the pending DB record.
   *
   * Queries `pending_asset_pubkey` (the pre-broadcast address) rather than
   * `asset_pubkey` (the confirmed on-chain address) so the lookup works before
   * the Helius confirmation event updates the record.
   *
   * Returns null instead of throwing when the agent is not found.
   */
  async findByPendingAsset(assetPubkey: string): Promise<AgentEntity | null> {
    const { data, error } = await this.supabase
      .from('agents')
      .select('*')
      .eq('pending_asset_pubkey', assetPubkey)
      .single();
    if (error) return null;
    return data as AgentEntity;
  }

  /**
   * Browses the agents table with optional filters.
   * category filter uses Supabase array contains (.contains) since `categories` is an array column.
   */
  async browse(filters: { category?: string; healthStatus?: string }): Promise<AgentEntity[]> {
    let query = this.supabase.from('agents').select('*');
    if (filters.category) {
      query = query.contains('categories', [filters.category]);
    }
    if (filters.healthStatus) {
      query = query.eq('health_status', filters.healthStatus);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as AgentEntity[];
  }

  /** Updates specified columns for an agent and returns the updated row. */
  async update(id: string, updates: Record<string, unknown>): Promise<AgentEntity> {
    const { data, error } = await this.supabase
      .from('agents')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data as AgentEntity;
  }

  /**
   * Stores the pre-generated asset public key while awaiting on-chain confirmation.
   * The key is moved from `pending_asset_pubkey` to `asset_pubkey` by `confirmRegistration`.
   */
  async setPendingAsset(id: string, assetPubkey: string): Promise<AgentEntity> {
    return this.update(id, { pending_asset_pubkey: assetPubkey });
  }

  /**
   * Deletes agents that are still in `pending` health_status and were created
   * before the given cutoff date.
   *
   * These are orphaned records from registration attempts where the user never
   * signed/broadcast the on-chain tx, or where the on-chain tx failed after
   * the DB record was already created.
   *
   * Returns the number of rows deleted.
   */
  async deletePendingOlderThan(cutoff: Date): Promise<number> {
    const { data, error } = await this.supabase
      .from('agents')
      .delete()
      .eq('health_status', 'pending')
      .lt('created_at', cutoff.toISOString())
      .select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  }
}
