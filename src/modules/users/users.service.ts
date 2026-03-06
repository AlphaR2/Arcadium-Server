import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { UserEntity } from '../../common/entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * Service layer for user management.
 * Wraps direct Supabase calls so controllers never touch the DB client.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /** Fetches a user by their internal UUID. Throws if not found. */
  async findById(id: string): Promise<UserEntity> {
    const { data, error } = await this.supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data as UserEntity;
  }

  /** Fetches a user by their Solana wallet public key. Throws if not found. */
  async findByPubkey(pubkey: string): Promise<UserEntity> {
    const { data, error } = await this.supabase
      .from('users')
      .select('*')
      .eq('pubkey', pubkey)
      .single();
    if (error) throw new Error(error.message);
    return data as UserEntity;
  }

  /**
   * Applies a partial update to a user record.
   * Only the fields present in `updates` are changed — Supabase ignores the rest.
   */
  async update(id: string, updates: UpdateUserDto): Promise<UserEntity> {
    const { data, error } = await this.supabase
      .from('users')
      .update({
        ...updates,
        onboarding_completed: true,
      } as Record<string, unknown>)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data as UserEntity;
  }
}
