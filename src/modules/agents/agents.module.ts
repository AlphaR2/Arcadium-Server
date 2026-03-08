import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentsRepository } from './agents.repository';
import { AgentsSchedulerService } from './agents-scheduler.service';

@Module({
  imports: [ScheduleModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentsRepository, AgentsSchedulerService],
  exports: [AgentsService, AgentsRepository],
})
export class AgentsModule {}
