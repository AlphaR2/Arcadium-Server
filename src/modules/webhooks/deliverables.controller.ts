import {
  Controller,
  Post,
  Body,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { HmacGuard } from '../../common/guards/hmac.guard';
import { DeliverablesService } from './deliverables.service';

/**
 * Body sent by an agent when posting a completed deliverable.
 * The agent must include the `envoy-signature` header (HMAC-SHA256 of the body
 * using the shared webhook_secret) for the request to pass HmacGuard.
 */
export class SubmitDeliverableDto {
  /** On-chain job ID (hex-encoded bytes) identifying the bounty. */
  @IsString()
  @ApiProperty({ description: 'On-chain job ID (hex-encoded bytes)' })
  job_id!: string;

  /** UUID of the bounty_registration row for this agent+bounty pair. */
  @IsString()
  @ApiProperty({ description: 'UUID of the bounty_registration record', format: 'uuid' })
  registration_id!: string;

  /** UUID of the submitting agent. Used to look up the webhook secret in HmacGuard. */
  @IsString()
  @ApiProperty({ description: 'UUID of the submitting agent', format: 'uuid' })
  agent_id!: string;

  /** Direct URL to the deliverable file (must be publicly accessible for re-hosting). */
  @IsString()
  @ApiProperty({ description: 'Publicly accessible URL to the deliverable file' })
  deliverable_url!: string;

  /** Format of the deliverable — must match the bounty's declared deliverable_format. */
  @IsString()
  @ApiProperty({ description: 'Deliverable format (document, markdown, code, data)' })
  deliverable_format!: string;

  /** Optional short note from the agent about the deliverable. */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Optional agent notes about the deliverable' })
  notes?: string;
}

/**
 * Receives completed deliverables from agent webhooks.
 * All requests are verified with HMAC-SHA256 using the agent's shared webhook_secret.
 */
@ApiTags('deliverables')
@Controller('deliverables')
export class DeliverablesController {
  private readonly logger = new Logger(DeliverablesController.name);

  constructor(private readonly deliverablesService: DeliverablesService) {}

  /**
   * POST /deliverables/submit
   * Agent callback endpoint — HMAC-verified via HmacGuard.
   *
   * The agent POSTs the deliverable URL; the server then:
   *   1. Validates the HMAC signature using the agent's webhook_secret
   *   2. Downloads the file from deliverable_url
   *   3. Re-hosts it on Cloudflare R2 (permanent storage)
   *   4. Links the deliverable to the bounty_registration record
   */
  @UseGuards(HmacGuard)
  @Post('submit')
  @ApiOperation({ summary: 'Submit a deliverable for a bounty (agent-facing, HMAC required)' })
  @ApiResponse({ status: 201, description: 'Deliverable accepted and queued for re-hosting' })
  @ApiResponse({ status: 401, description: 'Missing or invalid envoy-signature header' })
  async submit(@Body() body: SubmitDeliverableDto) {
    this.logger.log(
      `Deliverable submitted for job ${body.job_id} by agent ${body.agent_id}`,
    );
    return this.deliverablesService.handleSubmission(body);
  }
}
