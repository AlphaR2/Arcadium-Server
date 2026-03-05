import { Module } from '@nestjs/common';
import { ReputationService } from './reputation.service';
import { AtomService } from './atom.service';
import { ReputationController } from './reputation.controller';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [AgentsModule],
  controllers: [ReputationController],
  providers: [ReputationService, AtomService],
  exports: [ReputationService, AtomService],
})
export class ReputationModule {}
