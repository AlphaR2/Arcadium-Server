import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
/* @nestjs/bull v11 uses bullmq internally — import Queue from 'bullmq', not 'bull' */
import { Queue } from 'bullmq';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BountyRegistrationEntity } from '../../common/entities/bounty-registration.entity';
import { DeliverableEntity } from '../../common/entities/deliverable.entity';
import { DispatchJobPayload } from '../../common/interfaces';

/**
 * Manages agent registration for bounties and the dispatch queue.
 *
 * When an agent owner registers their agent:
 *   1. A bounty_registrations row is inserted with dispatch_state='pending'
 *   2. A 'dispatch-bounty' job is enqueued on the 'dispatch' Bull queue
 *   3. DispatchProcessor picks up the job and POSTs to the agent's webhook
 */
@Injectable()
export class BountiesRegistrationService {
  private readonly logger = new Logger(BountiesRegistrationService.name);
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    /* Inject the 'dispatch' Bull queue to enqueue delivery jobs */
    @InjectQueue('dispatch') private readonly dispatchQueue: Queue,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Registers an agent for a bounty and immediately enqueues a webhook dispatch job.
   * The job will be retried up to 3 times with exponential back-off (5 s base delay).
   */
  async registerAgent(
    bountyId: string,
    agentId: string,
    ownerId: string,
  ): Promise<BountyRegistrationEntity> {
    this.logger.log(`Registering agent ${agentId} for bounty ${bountyId}`);

    /* Create the registration record in pending state */
    const { data: reg, error } = await this.supabase
      .from('bounty_registrations')
      .insert({
        bounty_id: bountyId,
        agent_id: agentId,
        owner_id: ownerId,
        dispatch_state: 'pending',
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);

    const registration = reg as BountyRegistrationEntity;

    /* Build the job payload and enqueue for webhook delivery */
    const payload: DispatchJobPayload = {
      registrationId: registration.id,
      bountyId,
      agentId,
      ownerId,
    };

    await this.dispatchQueue.add('dispatch-bounty', payload, {
      /* 3 total attempts with exponential back-off starting at 5 seconds */
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    this.logger.log(`Enqueued dispatch for registration ${registration.id}`);
    return registration;
  }

  /** Removes an agent's registration for a bounty (before the submission deadline). */
  async deregisterAgent(bountyId: string, agentId: string): Promise<void> {
    await this.supabase
      .from('bounty_registrations')
      .delete()
      .eq('bounty_id', bountyId)
      .eq('agent_id', agentId);
  }

  /**
   * Re-enqueues a dispatch job for a registration that previously failed.
   * Returns { queued: false } if the registration record no longer exists.
   */
  async retryDispatch(registrationId: string): Promise<{ queued: boolean }> {
    this.logger.log(`Retry dispatch for registration ${registrationId}`);

    const { data: reg } = await this.supabase
      .from('bounty_registrations')
      .select('bounty_id, agent_id, owner_id')
      .eq('id', registrationId)
      .single();

    if (!reg) return { queued: false };

    const r = reg as Pick<BountyRegistrationEntity, 'bounty_id' | 'agent_id' | 'owner_id'>;
    const payload: DispatchJobPayload = {
      registrationId,
      bountyId: r.bounty_id,
      agentId: r.agent_id,
      ownerId: r.owner_id,
    };

    await this.dispatchQueue.add('dispatch-bounty', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return { queued: true };
  }

  /**
   * Returns all deliverables submitted for a bounty, each joined with its
   * bounty_registrations row so the client can identify the submitting agent.
   */
  async getSubmissions(bountyId: string): Promise<DeliverableEntity[]> {
    const { data, error } = await this.supabase
      .from('deliverables')
      .select('*, bounty_registrations(*)')
      .eq('bounty_id', bountyId);
    if (error) throw new Error(error.message);
    return (data ?? []) as DeliverableEntity[];
  }

  /**
   * Counts how many agents have submitted a deliverable for this bounty.
   * Used by the scheduler to decide whether to move a bounty to under_review.
   */
  async countSubmitted(bountyId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('bounty_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('bounty_id', bountyId)
      .not('deliverable_id', 'is', null);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  /** Counts total registrations for a bounty (submitted + pending). */
  async count(bountyId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('bounty_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('bounty_id', bountyId);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  /**
   * Returns all bounties dispatched to the caller's agents that are waiting to be
   * picked up (dispatch_state='queued', no deliverable submitted yet).
   *
   * Used by polling agents that have no webhook or Telegram configured.
   * The agent owner authenticates with their JWT, and this returns all pending
   * work across all their registered agents.
   */
  async getDispatched(ownerId: string): Promise<
    Array<{ registration_id: string; agent_id: string; bounty: Record<string, unknown> }>
  > {
    const { data, error } = await this.supabase
      .from('bounty_registrations')
      .select('id, agent_id, bounties(*)')
      .eq('owner_id', ownerId)
      .eq('dispatch_state', 'queued')
      .is('deliverable_id', null);

    if (error) throw new Error(error.message);

    return (data ?? []).map((row: Record<string, unknown>) => ({
      registration_id: row['id'] as string,
      agent_id: row['agent_id'] as string,
      bounty: row['bounties'] as Record<string, unknown>,
    }));
  }

  /**
   * Marks the winning registration in the bounty_registrations table.
   * Called after the client selects a winner via BountiesReviewService.
   */
  async setWinner(bountyId: string, agentId: string): Promise<void> {
    await this.supabase
      .from('bounty_registrations')
      .update({ is_winner: true })
      .eq('bounty_id', bountyId)
      .eq('agent_id', agentId);
  }
}
