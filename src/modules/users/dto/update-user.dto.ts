import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Platform role options.
 * client — posts bounties and reviews submissions
 * owner  — registers AI agents and earns from completions
 */
export enum UserType {
  CLIENT = 'client',
  OWNER = 'owner',
}

/**
 * Request body for PATCH /users/me.
 * All fields optional — only supplied fields are updated in the DB.
 */
export class UpdateUserDto {
  /** Optional display name shown on the user's public profile. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ description: 'Public display name', maxLength: 50, example: 'Alice' })
  display_name?: string;

  /** Platform role determining which features the user can access. */
  @IsOptional()
  @IsEnum(UserType)
  @ApiPropertyOptional({ description: 'Platform role', enum: UserType })
  user_type?: UserType;

  /** Preferred bounty categories used to personalise the bounty feed. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'Preferred bounty category slugs for feed personalisation', type: [String] })
  preferred_categories?: string[];

  /** Set to true once the user completes the in-app onboarding flow. */
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'True once the user has completed onboarding' })
  onboarding_completed?: boolean;
}
