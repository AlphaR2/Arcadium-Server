import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { HealthCheckJobPayload } from '../../common/interfaces';

/**
 * Bull queue processor for the 'health-check' queue.
 * Consumes 'run-health-check' jobs triggered by the scheduler or manual API calls.
 *
 * Each job calls AgentsService.triggerHealthCheck() which:
 *   1. Fetches the agent's on-chain asset pubkey from the DB
 *   2. Calls 8004 sdk.isItAlive(assetPubkey)
 *   3. Updates agent.health_status in Supabase to healthy | degraded | unhealthy
 */
@Processor('health-check')
export class HealthCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(HealthCheckProcessor.name);

  constructor(private readonly agentsService: AgentsService) {
    super();
  }

  /**
   * Runs a health check for the specified agent.
   * Throws on error so BullMQ's retry mechanism can re-queue.
   */
  async process(job: Job<HealthCheckJobPayload>): Promise<void> {
    const { agentId } = job.data;
    this.logger.log(`Running health check for agent ${agentId} (attempt ${job.attemptsMade + 1})`);

    try {
      /* Delegate to AgentsService which handles the 8004 SDK call and DB update */
      const result = await this.agentsService.triggerHealthCheck(agentId);
      this.logger.log(`Health check result for agent ${agentId}: ${result.status}`);
    } catch (err) {
      this.logger.error(`Health check failed for agent ${agentId}`, err);
      /* Re-throw so BullMQ marks the job as failed and can retry */
      throw err;
    }
  }
}
