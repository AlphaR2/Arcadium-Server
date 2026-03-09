import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as crypto from 'crypto';
import { DispatchJobPayload } from '../../common/interfaces';
import { BountyEntity } from '../../common/entities/bounty.entity';
import { AgentEntity } from '../../common/entities/agent.entity';

/**
 * Bull queue processor for the 'dispatch' queue.
 * Consumes 'dispatch-bounty' jobs enqueued when an agent registers for a bounty.
 *
 * Dispatch routing (in priority order):
 *   1. Agent has telegram_chat_id  → send Telegram bot message (no public server needed)
 *   2. Agent has webhook_url       → POST signed payload to webhook (original behaviour)
 *   3. Agent has neither           → mark dispatch_state='queued' (agent polls GET /bounties/dispatched)
 *
 * Telegram API is called directly via axios to avoid a circular module dependency
 * with TelegramModule. The bot token is read from ConfigService.
 */
@Processor('dispatch')
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);
  private readonly supabase: SupabaseClient;
  private readonly telegramApiBase: string;
  private readonly telegramEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    super();
    /* Direct Supabase client — avoids circular imports from BountiesModule/AgentsModule */
    this.supabase = createClient(
      config.get<string>('supabase.url') ?? '',
      config.get<string>('supabase.serviceKey') ?? '',
    );

    const token = config.get<string>('telegram.botToken') ?? '';
    this.telegramEnabled = token.length > 0;
    this.telegramApiBase = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Processes a single dispatch-bounty job.
   * Throws on failure so BullMQ's retry/backoff mechanism can re-queue the job.
   * After all attempts fail, BullMQ marks it 'failed' — caller can retry via
   * POST /bounties/:id/retry-dispatch/:regId.
   */
  async process(job: Job<DispatchJobPayload>): Promise<void> {
    const { registrationId, bountyId, agentId } = job.data;
    this.logger.log(
      `Dispatching bounty ${bountyId} to agent ${agentId} (attempt ${job.attemptsMade + 1})`,
    );

    /* ── Step 1: Load the bounty record ── */
    const { data: bountyData, error: bountyErr } = await this.supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .single();

    if (bountyErr || !bountyData) {
      throw new Error(`Bounty ${bountyId} not found: ${bountyErr?.message ?? 'unknown'}`);
    }
    const bounty = bountyData as BountyEntity;

    /* ── Step 2: Load agent dispatch config (webhook + telegram + token) ── */
    const { data: agentData, error: agentErr } = await this.supabase
      .from('agents')
      .select('webhook_url, webhook_secret, telegram_chat_id, agent_token')
      .eq('id', agentId)
      .single();

    if (agentErr || !agentData) {
      throw new Error(`Agent ${agentId} not found: ${agentErr?.message ?? 'unknown'}`);
    }
    const agent = agentData as Pick<AgentEntity, 'webhook_url' | 'webhook_secret' | 'telegram_chat_id' | 'agent_token'>;

    /* ── Step 2b: Load dispatch_nonce from registration ── */
    const { data: regData } = await this.supabase
      .from('bounty_registrations')
      .select('dispatch_nonce')
      .eq('id', registrationId)
      .single();
    const dispatchNonce = (regData as { dispatch_nonce: string | null } | null)?.dispatch_nonce ?? '';

    /* ── Route 1: Telegram (highest priority) ── */
    if (agent.telegram_chat_id && this.telegramEnabled) {
      await this.dispatchViaTelegram(agent.telegram_chat_id, registrationId, bounty, dispatchNonce);
      return;
    }

    /* ── Route 2: Webhook ── */
    if (agent.webhook_url) {
      await this.dispatchViaWebhook(agent, registrationId, bountyId, bounty);
      return;
    }

    /* ── Route 3: Polling fallback — no active channel configured ── */
    this.logger.log(
      `Agent ${agentId} has no webhook or Telegram — marking dispatch_state=queued for polling`,
    );
    await this.supabase
      .from('bounty_registrations')
      .update({ dispatch_state: 'queued' })
      .eq('id', registrationId);
  }

  /**
   * Sends a formatted bounty dispatch message via the Telegram Bot API.
   * Marks the registration as 'dispatched' on success.
   */
  private async dispatchViaTelegram(
    chatId: string,
    registrationId: string,
    bounty: BountyEntity,
    dispatchNonce: string,
  ): Promise<void> {
    const deadline = new Date(bounty.submission_deadline).toUTCString();

    const message = [
      '🎯 <b>New Bounty Dispatched</b>',
      '',
      `📋 <b>Title:</b> ${bounty.title}`,
      `💰 <b>Prize:</b> $${bounty.prize_usdc} USDC`,
      `📁 <b>Category:</b> ${bounty.category}`,
      `📄 <b>Format:</b> ${bounty.deliverable_format}`,
      `⏰ <b>Deadline:</b> ${deadline}`,
      '',
      '📝 <b>Description:</b>',
      bounty.description,
      '',
      '─────────────────────',
      '🔖 <b>Registration ID:</b>',
      `<code>${registrationId}</code>`,
      `🔑 <b>Nonce:</b> <code>${dispatchNonce}</code>`,
      '',
      'Submit your work as:',
      `<code>[${registrationId}] Your deliverable content here</code>`,
      '',
      '<i>Append to your submission:</i>',
      '<pre>---',
      `agent_token: your_agt_token`,
      `nonce_sig: sha256("${dispatchNonce}:${registrationId}")`,
      '---</pre>',
    ].join('\n');

    await axios.post(`${this.telegramApiBase}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });

    await this.supabase
      .from('bounty_registrations')
      .update({ dispatch_state: 'dispatched' })
      .eq('id', registrationId);

    this.logger.log(`Dispatched bounty ${bounty.id} via Telegram to chat ${chatId}`);
  }

  /**
   * POSTs a HMAC-SHA256 signed payload to the agent's webhook URL.
   * Marks the registration as 'dispatched' on success.
   * Throws on HTTP error so BullMQ can retry.
   */
  private async dispatchViaWebhook(
    agent: Pick<AgentEntity, 'webhook_url' | 'webhook_secret' | 'telegram_chat_id'>,
    registrationId: string,
    bountyId: string,
    bounty: BountyEntity,
  ): Promise<void> {
    const payload = {
      registration_id: registrationId,
      bounty_id: bountyId,
      job_id: bounty.job_id_bytes,
      title: bounty.title,
      description: bounty.description,
      category: bounty.category,
      deliverable_format: bounty.deliverable_format,
      prize_usdc: bounty.prize_usdc,
      submission_deadline: bounty.submission_deadline,
      review_deadline: bounty.review_deadline,
    };

    const body = JSON.stringify(payload);
    const sig = crypto
      .createHmac('sha256', agent.webhook_secret ?? '')
      .update(body)
      .digest('hex');

    await axios.post(agent.webhook_url!, payload, {
      headers: {
        'envoy-signature': sig,
        'content-type': 'application/json',
      },
      timeout: 10_000,
    });

    await this.supabase
      .from('bounty_registrations')
      .update({ dispatch_state: 'dispatched' })
      .eq('id', registrationId);

    this.logger.log(`Dispatched bounty ${bountyId} via webhook to ${agent.webhook_url}`);
  }
}
