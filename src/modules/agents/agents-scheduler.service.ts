import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AgentsRepository } from './agents.repository';

/**
 * Scheduled service that cleans up orphaned `pending` agent records.
 *
 * An agent record is created server-side before the client signs and
 * broadcasts the 8004 registerAgent tx. If the tx is never signed or fails
 * on-chain, the record stays in `pending` forever.
 *
 * This job runs every hour and deletes any `pending` agent older than 1 hour
 * — safely past the point where a legitimate in-flight tx could still confirm.
 */
@Injectable()
export class AgentsSchedulerService {
  private readonly logger = new Logger(AgentsSchedulerService.name);

  constructor(private readonly agentsRepository: AgentsRepository) {}

  /** Fires at the top of every hour (00:00, 01:00, 02:00 ...). */
  @Cron('0 * * * *')
  async cleanupStalePendingAgents(): Promise<void> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    this.logger.log(
      `cleanupStalePendingAgents — deleting pending agents created before ${cutoff.toISOString()}`,
    );

    try {
      const deleted = await this.agentsRepository.deletePendingOlderThan(cutoff);
      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} stale pending agent(s)`);
      } else {
        this.logger.log('No stale pending agents found');
      }
    } catch (err) {
      this.logger.error('cleanupStalePendingAgents failed', err);
    }
  }
}
