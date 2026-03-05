import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LogoutDto, NonceDto, RefreshDto, VerifyDto } from './dto/auth.dto';
import { WalletAuthGuard } from './guards/wallet-auth.guard';

/**
 * Handles wallet-based authentication using a challenge-response (nonce + Ed25519) flow.
 *
 * Flow:
 *   1. POST /auth/nonce   — client sends pubkey, receives a one-time nonce
 *   2. POST /auth/verify  — client signs the nonce with Phantom; receives JWT + refresh token
 *   3. POST /auth/refresh — exchange a refresh token for a new access token
 *   4. POST /auth/logout  — revoke a refresh token
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Step 1 — issues a short-lived nonce for the given wallet public key.
   * The client must sign this nonce with their Solana keypair and send it to /verify.
   */
  @Post('nonce')
  @ApiOperation({ summary: 'Request a nonce to sign (step 1 of wallet auth)' })
  @ApiBody({ type: NonceDto })
  @ApiResponse({ status: 201, description: 'Nonce issued', schema: { properties: { nonce: { type: 'string' } } } })
  async getNonce(@Body() dto: NonceDto): Promise<{ nonce: string }> {
    /* generateNonce stores the nonce in Redis with a 5-minute TTL */
    const nonce = await this.authService.generateNonce(dto.pubkey);
    return { nonce };
  }

  /**
   * Step 2 — verifies the Ed25519 signature, consumes the nonce,
   * upserts the user record, and issues a JWT access token + refresh token.
   * WalletAuthGuard validates the signature before this handler runs.
   */
  @Post('verify')
  @UseGuards(WalletAuthGuard)
  @ApiOperation({ summary: 'Verify wallet signature and receive JWT (step 2 of wallet auth)' })
  @ApiBody({ type: VerifyDto })
  @ApiResponse({ status: 201, description: 'Authentication successful', schema: { properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } } })
  @ApiResponse({ status: 401, description: 'Invalid signature or expired nonce' })
  async verify(@Body() dto: VerifyDto): Promise<{ accessToken: string; refreshToken: string }> {
    /* consumeNonce validates the stored nonce and deletes it (one-time use) */
    await this.authService.consumeNonce(dto.pubkey, dto.nonce);
    const user = await this.authService.upsertUser(dto.pubkey);
    return this.authService.issueTokens(user);
  }

  /**
   * Step 3 — issues a new 15-minute access token using a valid refresh token.
   * The refresh token itself is not rotated; revoke it explicitly via /logout.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange refresh token for new access token (step 3)' })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, description: 'New access token issued', schema: { properties: { accessToken: { type: 'string' } } } })
  @ApiResponse({ status: 401, description: 'Refresh token invalid or expired' })
  async refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string }> {
    return this.authService.refreshAccessToken(dto.refreshToken);
  }

  /**
   * Step 4 — revokes the refresh token by deleting it from Redis.
   * Subsequent calls to /refresh with the same token will be rejected.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke refresh token and log out (step 4)' })
  @ApiBody({ type: LogoutDto })
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }
}
