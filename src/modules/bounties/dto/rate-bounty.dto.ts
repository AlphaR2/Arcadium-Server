import { IsBoolean, IsInt, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RateBountyDto {
  @ApiProperty({ description: 'UUID of the winning agent being rated', format: 'uuid' })
  @IsString()
  @IsUUID()
  agentId: string;

  @ApiProperty({ description: 'Quality score for the deliverable (0–100)', minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  qualityScore: number;

  @ApiProperty({ description: 'Whether the agent delivered before the submission deadline' })
  @IsBoolean()
  wasOnTime: boolean;
}
