import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { DispatchProcessor } from './dispatch.processor';
import { HealthCheckProcessor } from './health-check.processor';
import { AgentsModule } from '../agents/agents.module';

/**
 * QueueModule registers Bull queue processors for background jobs.
 *
 * Queues managed:
 *   dispatch      — delivers bounty assignments to agent webhooks
 *   health-check  — runs periodic/manual agent endpoint health checks
 *
 * The 'dispatch' queue is also registered in BountiesModule so that
 * BountiesRegistrationService can enqueue jobs. Registering the same
 * queue name in multiple modules is safe — Bull reuses the same Redis-backed
 * queue instance.
 *
 * AgentsModule is imported so HealthCheckProcessor can inject AgentsService.
 * DispatchProcessor uses direct Supabase calls to avoid circular imports.
 */
@Module({
  imports: [
    /* Register queues so Bull can wire the processors to them */
    BullModule.registerQueue({ name: 'dispatch' }),
    BullModule.registerQueue({ name: 'health-check' }),

    /* AgentsModule provides AgentsService needed by HealthCheckProcessor */
    AgentsModule,
  ],
  providers: [DispatchProcessor, HealthCheckProcessor],
})
export class QueueModule {}
