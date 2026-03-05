import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Request } from 'express';
import { AgentsRepository } from '../../modules/agents/agents.repository';

/**
 * Hash-based Message Authentication Code guard for agent-facing webhook endpoints.
 *
 * Verification flow:
 *   1. Extract the `agent_id` from the request body (the agent must include it).
 *   2. Load the agent record from the DB to obtain its webhook_secret.
 *   3. Compute HMAC-SHA256(webhook_secret, JSON.stringify(body)).
 *   4. Compare (timing-safe) the computed digest against the `arcadium-signature` header.
 *
 * The guard is registered as a provider in WebhooksModule so NestJS can inject
 * AgentsRepository into it. WebhooksModule imports AgentsModule which exports AgentsRepository.
 */
@Injectable()
export class HmacGuard implements CanActivate {
  constructor(private readonly agentsRepository: AgentsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const sig = req.headers['arcadium-signature'] as string | undefined;

    /* The arcadium-signature header is mandatory for all agent webhook calls */
    if (!sig) {
      throw new UnauthorizedException('Missing arcadium-signature header');
    }

    /* agent_id must be present in the request body so we can look up the secret */
    const body = req.body as Record<string, unknown>;
    const agentId = body['agent_id'] as string | undefined;
    if (!agentId) {
      throw new UnauthorizedException('Missing agent_id in request body');
    }

    /* Fetch the agent to get its shared webhook secret */
    let agent: Awaited<ReturnType<typeof this.agentsRepository.findById>>;
    try {
      agent = await this.agentsRepository.findById(agentId);
    } catch {
      throw new UnauthorizedException('Agent not found');
    }

    if (!agent?.webhook_secret) {
      throw new UnauthorizedException('Agent has no webhook secret configured');
    }

    /* Compute the expected HMAC over the raw JSON body */
    const expected = crypto
      .createHmac('sha256', agent.webhook_secret)
      .update(JSON.stringify(body))
      .digest('hex');

    /*
     * Compare using timingSafeEqual to prevent timing-based attacks.
     * Buffers must be the same length or the comparison throws.
     */
    const sigBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    return true;
  }
}
