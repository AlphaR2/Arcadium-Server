import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body for POST /auth/nonce.
 * The client provides their wallet public key to receive a nonce to sign.
 */
export class NonceDto {
  /** Solana wallet public key (base58 encoded). */
  @IsString()
  @ApiProperty({ description: 'Solana wallet public key (base58 encoded)', example: '4Nd1mFhFBbHkjFbHkjFbHkjFbHkjFbHk' })
  pubkey: string;
}

/**
 * Request body for POST /auth/verify.
 * Submits the signed nonce; issues JWT + refresh token on success.
 */
export class VerifyDto {
  /** Solana wallet public key (base58 encoded). */
  @IsString()
  @ApiProperty({ description: 'Solana wallet public key (base58 encoded)' })
  pubkey: string;

  /** Ed25519 signature of the nonce, hex encoded. */
  @IsString()
  @ApiProperty({ description: 'Ed25519 signature of the nonce (hex encoded)' })
  signature: string;

  /** Nonce string previously issued by POST /auth/nonce. */
  @IsString()
  @ApiProperty({ description: 'Nonce returned by POST /auth/nonce' })
  nonce: string;
}

/**
 * Request body for POST /auth/refresh.
 * Exchanges a valid refresh token for a new short-lived access token.
 */
export class RefreshDto {
  /** Opaque refresh token issued alongside the original access token. */
  @IsString()
  @ApiProperty({ description: 'Refresh token issued during authentication' })
  refreshToken: string;
}

/**
 * Request body for POST /auth/logout.
 * Invalidates the refresh token stored in Redis.
 */
export class LogoutDto {
  /** Opaque refresh token to revoke. */
  @IsString()
  @ApiProperty({ description: 'Refresh token to invalidate' })
  refreshToken: string;
}
