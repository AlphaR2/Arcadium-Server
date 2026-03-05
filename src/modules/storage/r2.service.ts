import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * StorageService — wraps Supabase Storage for deliverable file hosting.
 *
 * Bucket: 'deliverables' (create in Supabase dashboard → Storage, set to private).
 * Public interface is identical to the previous R2 implementation so
 * DeliverablesService requires no changes.
 */

const BUCKET = 'deliverables';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Uploads a file buffer to the deliverables bucket.
   * upsert: true ensures re-submissions overwrite cleanly.
   */
  async upload(key: string, body: Buffer | Uint8Array | string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(BUCKET)
      .upload(key, body, { upsert: true });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    this.logger.log(`Uploaded to Supabase Storage: ${key}`);
  }

  /**
   * Returns a short-lived signed URL for the given storage key.
   * Default TTL is 15 min; DeliverablesService passes 7 days (604 800 s).
   */
  async getSignedUrl(key: string, ttlSeconds = 900): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(BUCKET)
      .createSignedUrl(key, ttlSeconds);

    if (error || !data) {
      throw new Error(`Signed URL failed: ${error?.message ?? 'no data'}`);
    }

    return data.signedUrl;
  }
}
