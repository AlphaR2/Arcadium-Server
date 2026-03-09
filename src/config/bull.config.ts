
import { ConfigModule, ConfigService } from '@nestjs/config';

export const bullConfig = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    // Strip any accidental surrounding quotes that can sneak in via Railway/env editors
    const rawUrl = (
      configService.get<string>('redis.url') ?? 'redis://localhost:6379'
    ).trim().replace(/^["']|["']$/g, '');

    // Parse the redis:// or rediss:// URL
    const parsed = new URL(rawUrl);

    // Detect TLS (rediss:// protocol or explicit env var)
    const useTls =
      parsed.protocol === 'rediss:' ||
      configService.get<string>('REDIS_USE_TLS') === 'true' ||
      configService.get<boolean>('REDIS_USE_TLS') === true;

    return {
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port) || 6379,

        // Username (rare in Redis but supported in some hosted providers)
        ...(parsed.username && {
          username: decodeURIComponent(parsed.username),
        }),

        // Password from URL (most common)
        ...(parsed.password && {
          password: decodeURIComponent(parsed.password),
        }),

        // Optional: explicit db index from URL query (?db=1) or env
        db: Number(
          parsed.searchParams.get('db') ||
            configService.get<number>('REDIS_DB') ||
            0,
        ),

        // Enable TLS when needed (Upstash, Railway, Render, AWS ElastiCache, etc.)
        ...(useTls && { tls: {} }),
      },

      // Sensible global defaults for jobs (very common in production)
      defaultJobOptions: {
        attempts: Number(
          configService.get<number>('QUEUE_DEFAULT_ATTEMPTS') || 4,
        ),
        backoff: {
          type: 'exponential',
          delay: 3000, // initial delay in ms
        },
        removeOnComplete: {
          age: 3600, // 1 hour
          count: 1000, // keep last 1000 completed
        },
        removeOnFail: {
          age: 24 * 3600, // 1 day
          count: 1000,
        },
      },
    };
  },
};
