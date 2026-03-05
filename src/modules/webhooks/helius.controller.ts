import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { HeliusService } from './helius.service';

/**
 * Receives enhanced transaction event webhooks from Helius.
 * Routes each transaction to the appropriate handler based on the instruction discriminator.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class HeliusController {
  private readonly logger = new Logger(HeliusController.name);

  constructor(
    private readonly heliusService: HeliusService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /webhooks/helius
   * Entry point for all on-chain event notifications from Helius.
   *
   * The body is an array of enhanced transaction objects.
   * When SOLANA_HELIUS_WEBHOOK_SECRET is configured, the helius-signature header is
   * validated with HMAC-SHA256 before processing any events.
   *
   * Each transaction is routed to HeliusService.route() which dispatches based on the
   * instruction discriminator (e.g. create_escrow → mark bounty open, register_agent → confirm agent).
   */
  @Post('helius')
  @ApiOperation({ summary: 'Helius enhanced transaction webhook endpoint (Solana event routing)' })
  @ApiHeader({ name: 'helius-signature', description: 'HMAC-SHA256 signature from Helius (required when secret is configured)', required: false })
  @ApiResponse({ status: 201, description: 'Events processed', schema: { properties: { ok: { type: 'boolean' } } } })
  @ApiResponse({ status: 401, description: 'Invalid or missing helius-signature header' })
  async handleHelius(
    @Body() body: unknown,
    @Headers('helius-signature') sig: string | undefined,
  ): Promise<{ ok: boolean }> {
    const secret = this.config.get<string>('solana.heliusWebhookSecret') ?? '';

    /* Validate HMAC signature if a secret is configured */
    if (secret) {
      if (!sig) throw new UnauthorizedException('Missing helius-signature');

      const expected = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(body))
        .digest('hex');

      if (sig !== expected) {
        throw new UnauthorizedException('Invalid helius-signature');
      }
    }

    /* Normalise to an array — Helius sends either a single object or an array */
    const transactions = Array.isArray(body) ? body : [body];
    this.logger.log(`Helius webhook: ${transactions.length} tx(s)`);

    /* Route each transaction; log errors but do not abort the batch */
    for (const tx of transactions) {
      try {
        await this.heliusService.route(tx as Record<string, unknown>);
      } catch (err) {
        this.logger.error('Error routing Helius tx', err);
      }
    }

    return { ok: true };
  }
}
