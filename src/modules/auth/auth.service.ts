import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';
import * as crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { JwtPayload } from './strategies/jwt.strategy';

const NONCE_TTL_SEC = 5 * 60; // 5 minutes
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabase: SupabaseClient;
  private readonly redis: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    this.supabase = createClient(
      this.config.get<string>('supabase.url') ?? '',
      this.config.get<string>('supabase.serviceKey') ?? '',
    );
    this.redis = new Redis({
      url: this.config.get<string>('redis.restUrl') ?? '',
      token: this.config.get<string>('redis.restToken') ?? '',
    });
  }

  /** Issues a short-lived nonce for the given pubkey (5 min TTL). */
  async generateNonce(pubkey: string): Promise<string> {
    const nonce = crypto.randomBytes(32).toString('hex');
    await this.redis.set(`nonce:${pubkey}`, nonce, { ex: NONCE_TTL_SEC });
    return nonce;
  }

  /** Validates the stored nonce for the pubkey and removes it (one-time use). */
  async consumeNonce(pubkey: string, nonce: string): Promise<void> {
    const stored = await this.redis.get<string>(`nonce:${pubkey}`);
    if (!stored || stored !== nonce) {
      throw new UnauthorizedException('Invalid or expired nonce');
    }
    await this.redis.del(`nonce:${pubkey}`);
  }

  /** Adds and creates the user by pubkey and returns the internal user record. */
  async upsertUser(pubkey: string): Promise<{
    id: string;
    pubkey: string;
    user_type: string | null;
    preferred_categories: string[];
  }> {
    const { data, error } = await this.supabase
      .from('users')
      .upsert({ pubkey }, { onConflict: 'pubkey' })
      .select('id, pubkey, user_type, preferred_categories')
      .single();

    if (error || !data) {
      this.logger.error('upsertUser failed', error);
      throw new BadRequestException('Failed to upsert user');
    }

    return data as {
      id: string;
      pubkey: string;
      user_type: string | null;
      preferred_categories: string[];
    };
  }

  /** Issues a RS256 access token (15min) and a refresh token stored in Redis (30d). */
  async issueTokens(user: {
    id: string;
    pubkey: string;
    preferred_categories: string[];
  }): Promise<{ accessToken: string; refreshToken: string }> {
    const payload: Omit<JwtPayload, 'exp'> = {
      sub: user.id,
      pubkey: user.pubkey,
      roles: ['user'],
      preferred_categories: user.preferred_categories ?? [],
    };

    const accessToken = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = crypto.randomBytes(40).toString('hex');

    await this.storeRefreshToken(user.id, user.pubkey, refreshToken);

    return { accessToken, refreshToken };
  }

  /** Refreshes an access token using a valid refresh token. */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string }> {
    const entry = await this.findRefreshToken(refreshToken);
    if (!entry) throw new UnauthorizedException('Invalid refresh token');

    const accessToken = this.jwtService.sign(
      {
        sub: entry.userId,
        pubkey: entry.pubkey,
        roles: entry.roles,
        preferred_categories: entry.preferred_categories,
      },
      { expiresIn: '15m' },
    );

    return { accessToken };
  }

  /** Invalidates the refresh token. */
  async logout(refreshToken: string): Promise<void> {
    await this.revokeRefreshToken(refreshToken);
  }

  // Refresh token store — Upstash Redis
  // Key: refresh:{userId}:{tokenHash}

  private tokenHash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async storeRefreshToken(
    userId: string,
    pubkey: string,
    token: string,
  ): Promise<void> {
    const hash = this.tokenHash(token);
    const key = `refresh:${userId}:${hash}`;
    await this.redis.set(
      key,
      JSON.stringify({ userId, pubkey, roles: ['user'], preferred_categories: [] }),
      { ex: REFRESH_TTL_SEC },
    );
  }

  private async findRefreshToken(token: string): Promise<{
    userId: string;
    pubkey: string;
    roles: string[];
    preferred_categories: string[];
  } | null> {
    const hash = this.tokenHash(token);
    // We need to scan all user IDs — not ideal, but refresh tokens include the hash.
    // Pattern: refresh:*:{hash}
    const keys = await this.redis.keys(`refresh:*:${hash}`);
    if (!keys || keys.length === 0) return null;

    const entry = await this.redis.get<{
      userId: string;
      pubkey: string;
      roles: string[];
      preferred_categories: string[];
    }>(keys[0]);
    if (!entry) return null;

    return entry;
  }

  private async revokeRefreshToken(token: string): Promise<void> {
    const hash = this.tokenHash(token);
    const keys = await this.redis.keys(`refresh:*:${hash}`);
    if (keys && keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
