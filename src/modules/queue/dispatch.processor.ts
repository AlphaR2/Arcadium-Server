import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as crypto from 'crypto';
import { DispatchJobPayload } from '../../common/interfaces';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { AgentEntity } from '../../common/entities/agent.entity';

/**
 * Bull queue processor for the 'dispatch' queue.
 * Consumes 'dispatch-bounty' jobs that are enqueued whenever an agent owner
 * registers their agent for a bounty.
 *
 * Job lifecycle:
 *   1. Fetch bounty details from Supabase
 *   2. Fetch agent webhook URL and secret from Supabase
 *   3. Build a signed dispatch payload
 *   4. POST to the agent's webhook URL with HMAC-SHA256 signature header
 *   5. Update the bounty_registration.dispatch_state to 'dispatched' on success
 *      or 'failed' after all retry attempts are exhausted
 */
@Processor('dispatch')
@Injectable()
export class DispatchProcessor {
  private readonly logger = new Logger(DispatchProcessor.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    /* Direct Supabase client — avoids circular imports from BountiesModule/AgentsModule */
    this.supabase = createClient(
      config.get<string>('supabase.url') ?? '',
      config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Processes a single dispatch-bounty job.
   * Throws on failure so Bull's retry/backoff mechanism can re-queue the job.
   * After all attempts fail, Bull marks the job as failed and the caller can
   * use POST /bounties/:id/retry-dispatch/:regId to re-enqueue manually.
   */
  @Process('dispatch-bounty')
  async handleDispatch(job: Job<DispatchJobPayload>): Promise<void> {
    const { registrationId, bountyId, agentId } = job.data;
    this.logger.log(`Dispatching bounty ${bountyId} to agent ${agentId} (attempt ${job.attemptsMade + 1})`);

    /* Step 1: Load the bounty record */
    const { data: bountyData, error: bountyErr } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .single();

    if (bountyErr || !bountyData) {
      throw new Error(`Bounty ${bountyId} not found: ${bountyErr?.message ?? 'unknown'}`);
    }
    const bounty = bountyData as BountyEntity;

    /* Step 2: Load the agent's webhook URL and shared secret */
    const { data: agentData, error: agentErr } = await this.supabase
      .from('agents')
      .select('webhook_url, webhook_secret')
      .eq('id', agentId)
      .single();

    if (agentErr || !agentData) {
      throw new Error(`Agent ${agentId} not found: ${agentErr?.message ?? 'unknown'}`);
    }
    const agent = agentData as Pick<AgentEntity, 'webhook_url' | 'webhook_secret'>;

    /* Step 3: Build the dispatch payload sent to the agent */
    const payload = {
      registration_id: registrationId,
      bounty_id: bountyId,
      job_id: bounty.job_id_bytes,       // on-chain job ID (hex bytes)
      title: bounty.title,
      description: bounty.description,
      category: bounty.category,
      deliverable_format: bounty.deliverable_format,
      prize_usdc: bounty.prize_usdc,
      submission_deadline: bounty.submission_deadline,
      review_deadline: bounty.review_deadline,
    };

    /* Step 4: Sign the body with HMAC-SHA256 using the agent's webhook secret */
    const body = JSON.stringify(payload);
    const sig = crypto
      .createHmac('sha256', agent.webhook_secret)
      .update(body)
      .digest('hex');

    /* POST to the agent's webhook — timeout after 10 seconds */
    await axios.post(agent.webhook_url, payload, {
      headers: {
        'arcadium-signature': sig,
        'content-type': 'application/json',
      },
      timeout: 10_000,
    });

    /* Step 5: Update dispatch_state to 'dispatched' on success */
    await this.supabase
      .from('bounty_registrations')
      .update({ dispatch_state: 'dispatched' })
      .eq('id', registrationId);

    this.logger.log(`Dispatched bounty ${bountyId} to agent ${agentId} successfully`);
  }
}
