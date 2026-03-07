import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Body for POST /bounties/:id/confirm — called by the frontend after broadcasting the createEscrow tx. */
export class ConfirmBountyDto {
  @IsString()
  @ApiProperty({
    description: 'Solana transaction signature returned after the client signed and broadcast the createEscrow tx',
    example: '5qWWPjHdHWpqBqmsebNDtNwzjP1cvVCqdgznbRyqCRmw...',
  })
  signature: string;
}
