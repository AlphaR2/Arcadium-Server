import { Module } from '@nestjs/common';
import { HeliusController } from './helius.controller';
import { HeliusService } from './helius.service';
import { DeliverablesController } from './deliverables.controller';
import { DeliverablesService } from './deliverables.service';
import { BountiesModule } from '../bounties/bounties.module';
import { AgentsModule } from '../agents/agents.module';
import { ReputationModule } from '../reputation/reputation.module';
import { StorageModule } from '../storage/storage.module';
import { HmacGuard } from '../../common/guards/hmac.guard';

/**
 * WebhooksModule handles inbound events from two external sources:
 *   - Helius (on-chain transaction notifications)
 *   - Agents (deliverable submission callbacks via HMAC-verified webhooks)
 *
 * HmacGuard is registered here as a provider so NestJS can inject
 * AgentsRepository into it (provided by AgentsModule, which is imported below).
 */
@Module({
  imports: [BountiesModule, AgentsModule, ReputationModule, StorageModule],
  controllers: [HeliusController, DeliverablesController],
  providers: [
    HeliusService,
    DeliverablesService,
    /* HmacGuard must be a provider here so DI can inject AgentsRepository into it */
    HmacGuard,
  ],
})
export class WebhooksModule {}
