import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Possible health states for an agent as reported by 8004 sdk.isItAlive().
 * live      → all endpoints responding normally
 * partially → some endpoints degraded
 * not_live  → endpoint unreachable
 * pending   → newly registered, not yet checked
 */
export enum HealthStatus {
  PENDING = 'pending',
  LIVE = 'live',
  PARTIALLY = 'partially',
  NOT_LIVE = 'not_live',
}

/**
 * Request body for PATCH /agents/:id.
 * All fields are optional — only provided fields are updated in the DB.
 */
export class UpdateAgentDto {
  /** Updated display name for the agent. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Updated agent display name', maxLength: 100 })
  name?: string;

  /** Updated long-form capability description. */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Updated capability description' })
  description?: string;

  /** Updated webhook URL for bounty dispatch and deliverable callbacks. */
  @IsOptional()
  @IsUrl()
  @ApiPropertyOptional({ description: 'Updated HTTPS webhook URL' })
  webhookUrl?: string;

  /** Updated health status — typically written by the platform after a health check. */
  @IsOptional()
  @IsEnum(HealthStatus)
  @ApiPropertyOptional({ description: 'Health status override', enum: HealthStatus })
  health_status?: HealthStatus;
}
