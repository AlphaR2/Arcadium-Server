import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';

/*
 * Feature modules — all live under src/modules/.
 * The paths below are relative to this file (src/app.module.ts).
 */
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { AgentsModule } from './modules/agents/agents.module';
import { BountiesModule } from './modules/bounties/bounties.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { StorageModule } from './modules/storage/storage.module';
import { ReputationModule } from './modules/reputation/reputation.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { QueueModule } from './modules/queue/queue.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { bullConfig } from './config/bull.config';

/**
 * Root application module.
 * Registers global providers (config, scheduler, Bull) and imports all feature modules.
 */
@Module({
  imports: [
    /* ConfigModule is global — all modules can inject ConfigService without re-importing */
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    /* ScheduleModule enables @Cron decorators across the app (e.g. bounty deadline checks) */
    ScheduleModule.forRoot(),

    /*
     * BullModule global config — connects to Redis via the redis.url config key.
     * Individual queues are registered per-module with BullModule.registerQueue().
     */
    BullModule.forRootAsync(bullConfig),

    /* Feature modules */
    AuthModule,
    UsersModule,
    AgentsModule,
    BountiesModule,
    EscrowModule,
    StorageModule,
    ReputationModule,
    WebhooksModule,
    QueueModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
