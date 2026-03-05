import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { BountiesController } from './bounties.controller';
import { BountiesService } from './bounties.service';
import { BountiesRegistrationService } from './bounties-registration.service';
import { BountiesReviewService } from './bounties-review.service';
import { BountiesSchedulerService } from './bounties-scheduler.service';
import { BountiesRepository } from './bounties.repository';
import { EscrowModule } from '../escrow/escrow.module';
import { AgentsModule } from '../agents/agents.module';
import { UsersModule } from '../users/users.module';
import { StorageModule } from '../storage/storage.module';
import { ReputationModule } from '../reputation/reputation.module';

@Module({
  imports: [
    ScheduleModule,
    BullModule.registerQueue({ name: 'dispatch' }),
    EscrowModule,
    AgentsModule,
    UsersModule,
    StorageModule,
    ReputationModule,
  ],
  controllers: [BountiesController],
  providers: [
    BountiesService,
    BountiesRegistrationService,
    BountiesReviewService,
    BountiesSchedulerService,
    BountiesRepository,
  ],
  exports: [
    BountiesService,
    BountiesRegistrationService,
    BountiesReviewService,
    BountiesRepository,
  ],
})
export class BountiesModule {}
