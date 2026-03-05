import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BountyCategory } from '../../agents/dto/create-agent.dto';

/**
 * Deliverable formats a bounty can request from agents.
 * The agent must submit a file of this format when responding to the bounty.
 */
export enum DeliverableFormat {
  DOCUMENT = 'document',
  MARKDOWN = 'markdown',
  CODE = 'code',
  DATA = 'data',
}

/**
 * Request body for POST /bounties.
 * Creates a bounty record and returns an unsigned create_escrow transaction.
 * The client signs and broadcasts the tx via Phantom to fund the on-chain USDC escrow.
 */
export class CreateBountyDto {
  /** Short title shown on the bounty listing page. */
  @IsString()
  @MaxLength(200)
  @ApiProperty({ description: 'Bounty title (max 200 characters)', example: 'Write a technical blog post about Solana Pay' })
  title: string;

  /** Full description of the task, requirements, and acceptance criteria. */
  @IsString()
  @ApiProperty({ description: 'Detailed task description and acceptance criteria' })
  description: string;

  /** Category used for agent matching and leaderboard filtering. */
  @IsEnum(BountyCategory)
  @ApiProperty({
    description: 'Bounty category for agent matching',
    enum: BountyCategory,
    example: 'WRITING',
  })
  category: BountyCategory;

  /** Format agents must use when submitting their deliverable. */
  @IsEnum(DeliverableFormat)
  @ApiProperty({
    description: 'Required deliverable format for submissions',
    enum: DeliverableFormat,
    example: 'markdown',
  })
  deliverableFormat: DeliverableFormat;

  /** Prize amount in USDC (e.g. 50.0 = $50). Converted to lamports server-side. */
  @IsNumber()
  @IsPositive()
  @ApiProperty({ description: 'Prize amount in USDC (positive number)', example: 50 })
  prizeUsdc: number;

  /** ISO 8601 deadline by which agents must submit their deliverable. */
  @IsISO8601()
  @ApiProperty({ description: 'Submission deadline (ISO 8601)', example: '2025-08-01T00:00:00Z' })
  submissionDeadline: string;

  /** ISO 8601 deadline for the client to pick a winner — must be after submissionDeadline. */
  @IsISO8601()
  @ApiProperty({ description: 'Review and winner-selection deadline (ISO 8601)', example: '2025-08-07T00:00:00Z' })
  reviewDeadline: string;

  /** Optional cap on participating agents. Omit for unlimited participation. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Max participating agents (omit for unlimited)', minimum: 1, example: 10 })
  maxParticipants?: number;
}
