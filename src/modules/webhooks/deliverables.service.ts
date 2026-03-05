import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { R2Service } from '../storage/r2.service';
import axios from 'axios';

@Injectable()
export class DeliverablesService {
  private readonly logger = new Logger(DeliverablesService.name);
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    private readonly r2: R2Service,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Handles a deliverable submission from an agent.
   * 1. Validates registration exists + not already submitted
   * 2. Downloads the file from the agent-provided URL
   * 3. Re-hosts to Cloudflare R2
   * 4. Creates a deliverable record and links to the registration
   */
  async handleSubmission(body: {
    job_id: string;
    registration_id: string;
    agent_id: string;
    deliverable_url: string;
    deliverable_format: string;
    notes?: string;
  }): Promise<{ deliverableId: string; r2Url: string }> {
    // 1. Validate registration
    const { data: reg, error: regError } = await this.supabase
      .from('bounty_registrations')
      .select('id, bounty_id, deliverable_id, dispatch_state')
      .eq('id', body.registration_id)
      .eq('agent_id', body.agent_id)
      .single();

    if (regError || !reg) {
      throw new BadRequestException('Registration not found');
    }

    const r = reg as Record<string, unknown>;
    if (r['deliverable_id']) {
      throw new BadRequestException('Deliverable already submitted');
    }

    // 2. Download file from agent URL
    let fileBuffer: Buffer;
    try {
      const response = await axios.get<ArrayBuffer>(body.deliverable_url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 50MB limit
      });
      fileBuffer = Buffer.from(response.data);
    } catch (err) {
      this.logger.error(`Failed to download deliverable from ${body.deliverable_url}`, err);
      throw new BadRequestException('Failed to download deliverable');
    }

    // 3. Upload to R2
    const key = `deliverables/${body.agent_id}/${body.registration_id}/${Date.now()}.${body.deliverable_format}`;
    await this.r2.upload(key, fileBuffer);
    const r2Url = await this.r2.getSignedUrl(key, 60 * 60 * 24 * 7); // 7 day signed URL

    // 4. Create deliverable record
    const { data: deliverable, error: delError } = await this.supabase
      .from('deliverables')
      .insert({
        job_id: body.job_id,
        agent_id: body.agent_id,
        format: body.deliverable_format,
        file_url: key,
        submitted_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (delError || !deliverable) {
      throw new BadRequestException('Failed to create deliverable record');
    }

    const deliverableId = (deliverable as Record<string, string>)['id'];

    // 5. Link deliverable to registration + mark dispatched
    await this.supabase
      .from('bounty_registrations')
      .update({
        deliverable_id: deliverableId,
        dispatch_state: 'delivered',
      })
      .eq('id', body.registration_id);

    this.logger.log(
      `Deliverable ${deliverableId} stored at ${key} for registration ${body.registration_id}`,
    );

    return { deliverableId, r2Url };
  }
}
