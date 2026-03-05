import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Bounty category enum shared between agents and bounties.
 * Agents declare which categories they handle; bounties are posted under one category.
 */
export enum BountyCategory {
  DEVELOPMENT = 'DEVELOPMENT',
  RESEARCH = 'RESEARCH',
  WRITING = 'WRITING',
  SECURITY = 'SECURITY',
}

/**
 * Request body for POST /agents.
 * Registers a new AI agent on the marketplace.
 * The server validates the webhook URL, builds OASF metadata, uploads it to IPFS,
 * and returns an unsigned 8004 registration transaction for the owner to sign via Phantom.
 */
export class CreateAgentDto {
  /** Human-readable display name shown on the marketplace listing. */
  @IsString()
  @MaxLength(100)
  @ApiProperty({ description: 'Human-readable agent name', maxLength: 100, example: 'My Research Agent' })
  name: string;

  /** Optional long-form description of what the agent does and its capabilities. */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Long-form capability description' })
  description?: string;

  /** Bounty categories this agent accepts — used for matching and leaderboards. */
  @IsArray()
  @IsEnum(BountyCategory, { each: true })
  @ApiProperty({
    description: 'Bounty categories this agent accepts',
    enum: BountyCategory,
    isArray: true,
    example: ['DEVELOPMENT', 'RESEARCH'],
  })
  categories: BountyCategory[];

  /** Granular skill tags within the declared categories. Stored as OASF skills in IPFS metadata. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'Granular specialisation tags within declared categories', type: [String] })
  specialisationTags?: string[];

  /**
   * HTTPS endpoint the platform uses to:
   * 1. Deliver bounty dispatch payloads (POST with HMAC-SHA256 signed body)
   * 2. Receive deliverable submission callbacks from the agent
   */
  @IsUrl()
  @ApiProperty({ description: 'HTTPS webhook URL for dispatch and deliverable callbacks', example: 'https://my-agent.example.com/webhook' })
  webhookUrl: string;

  /** Optional IPFS or HTTPS URI for the agent's marketplace profile image. */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Optional profile image URI (IPFS or HTTPS)' })
  imageUri?: string;

  /** Deliverable formats this agent can produce (e.g. document, code, data). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'Supported deliverable formats', type: [String], example: ['document', 'code'] })
  supportedFormats?: string[];

  /** Skill identifiers listed in the OASF metadata uploaded to IPFS during registration. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'OASF skill identifiers included in IPFS metadata', type: [String] })
  skills?: string[];

  /** Domain tags listed in the OASF metadata uploaded to IPFS during registration. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'OASF domain tags included in IPFS metadata', type: [String] })
  domains?: string[];
}
