import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { R2Service } from '../storage/r2.service';
import { ReputationService } from '../reputation/reputation.service';
import * as crypto from 'crypto';
import axios from 'axios';

/** Computes the expected nonce_sig the AI should have produced. */
function expectedNonceSig(nonce: string, registrationId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${nonce}:${registrationId}`)
    .digest('hex');
}

@Injectable()
export class DeliverablesService {
  private readonly logger = new Logger(DeliverablesService.name);
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    private readonly r2: R2Service,
    private readonly reputationService: ReputationService,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Handles a deliverable submission from an agent via HTTP webhook.
   * 1. Validates registration exists + not already submitted
   * 2. Validates agent_token + nonce_sig footer fields if agent has a token set
   * 3. Determines whether the submission is on-time vs the bounty deadline
   * 4. Downloads the file from the agent-provided URL
   * 5. Re-hosts to Cloudflare R2
   * 6. Creates a deliverable record and links to the registration
   * 7. Awards agent XP and updates stats — fire-and-forget, never blocks the response
   */
  async handleSubmission(body: {
    job_id: string;
    registration_id: string;
    agent_id: string;
    deliverable_url: string;
    deliverable_format: string;
    notes?: string;
    /* AI submission verification fields */
    agent_token?: string;
    nonce_sig?: string;
  }): Promise<{ deliverableId: string; r2Url: string }> {
    // 1. Validate registration + load agent token, nonce, and bounty deadline
    const { data: reg, error: regError } = await this.supabase
      .from('bounty_registrations')
      .select(
        'id, bounty_id, deliverable_id, dispatch_state, dispatch_nonce, ' +
          'agents(agent_token), bounties(submission_deadline)',
      )
      .eq('id', body.registration_id)
      .eq('agent_id', body.agent_id)
      .single();

    if (regError || !reg) {
      throw new BadRequestException('Registration not found');
    }

    const r = reg as unknown as Record<string, unknown>;

    if (r['deliverable_id']) {
      throw new BadRequestException('Deliverable already submitted');
    }

    // 2. Validate agent_token + nonce_sig if the agent has a token configured
    const agentData = r['agents'] as { agent_token?: string } | null;
    const storedToken = agentData?.agent_token;
    const storedNonce = r['dispatch_nonce'] as string | null;

    if (storedToken) {
      if (body.agent_token !== storedToken) {
        throw new BadRequestException('Invalid agent_token');
      }
      if (storedNonce) {
        const expected = expectedNonceSig(storedNonce, body.registration_id);
        if (body.nonce_sig !== expected) {
          throw new BadRequestException('Invalid nonce_sig');
        }
      }
    }

    // 3. Determine if submission is on-time vs the bounty's submission_deadline
    const bountyData = r['bounties'] as { submission_deadline?: string } | null;
    const submissionDeadline = bountyData?.submission_deadline;
    /* Default to on-time when the deadline field is not available */
    const wasOnTime = submissionDeadline
      ? new Date() <= new Date(submissionDeadline)
      : true;

    // 4. Download file from agent URL
    let fileBuffer: Buffer;
    try {
      const response = await axios.get<ArrayBuffer>(body.deliverable_url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 50 MB limit
      });
      fileBuffer = Buffer.from(response.data);
    } catch (err) {
      this.logger.error(
        `Failed to download deliverable from ${body.deliverable_url}`,
        err,
      );
      throw new BadRequestException('Failed to download deliverable');
    }

    // 5. Upload to R2
    const key = `deliverables/${body.agent_id}/${body.registration_id}/${Date.now()}.${body.deliverable_format}`;
    await this.r2.upload(key, fileBuffer);
    const r2Url = await this.r2.getSignedUrl(key, 60 * 60 * 24 * 7); // 7-day signed URL

    // 6. Create deliverable record
    const { data: deliverable, error: delError } = await this.supabase
      .from('deliverables')
      .insert({
        bounty_id: r['bounty_id'],
        registration_id: body.registration_id,
        agent_id: body.agent_id,
        deliverable_url: body.deliverable_url,
        deliverable_format: body.deliverable_format,
        hosted_url: r2Url,
        notes: body.notes,
      })
      .select('id')
      .single();

    if (delError || !deliverable) {
      throw new BadRequestException('Failed to create deliverable record');
    }

    const deliverableId = (deliverable as Record<string, string>)['id'];

    // Link deliverable to registration
    await this.supabase
      .from('bounty_registrations')
      .update({
        deliverable_id: deliverableId,
        dispatch_state: 'dispatched',
      })
      .eq('id', body.registration_id);

    this.logger.log(
      `Deliverable ${deliverableId} stored at ${key} for registration ` +
        `${body.registration_id} (onTime=${wasOnTime})`,
    );

    // 7. Update agent reputation — fire-and-forget, never blocks the response
    this.reputationService
      .incrementAgentSubmission(body.agent_id, wasOnTime)
      .catch((err) => {
        this.logger.warn(
          `incrementAgentSubmission failed for agent ${body.agent_id}: ${String(err)}`,
        );
      });

    return { deliverableId, r2Url };
  }
}
