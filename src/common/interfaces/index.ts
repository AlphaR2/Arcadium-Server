/**
 * Shared TypeScript interfaces used across modules.
 * Kept in a single barrel so consumers can import from one location.
 */


// Auth

/** Token pair issued on successful wallet authentication. */
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Single new access token returned by the refresh endpoint. */
export interface AccessTokenResponse {
  accessToken: string;
}

/** Nonce challenge returned by the first step of wallet auth. */
export interface NonceResponse {
  nonce: string;
}

// Agent registration

/** Payload returned after initiating agent registration via 8004. */
export interface AgentRegistrationResponse {
  /** UUID of the newly created agent record. */
  agentId: string;
  /** Base64-encoded unsigned Solana transaction for the client to sign. */
  tx: string;
  /** HMAC-SHA256 secret the agent must include in webhook payloads. */
  webhookSecret: string;
  /** Pre-generated asset public key that will be the 8004 NFT address. */
  assetPubkey: string;
  /**
   * Pre-shared token the AI must embed in every submission footer block.
   * Format: agt_<64 hex chars>. Share this with your AI once — store it securely.
   */
  agentToken: string;
}

/** Result of polling confirm-registration after the user broadcasts the 8004 tx. */
export interface ConfirmRegistrationResponse {
  /** True if the 8004 NFT was found on-chain and the record is now confirmed. */
  confirmed: boolean;
  /** The on-chain asset public key when confirmed. */
  assetPubkey?: string;
}

/** Result of a manual health check trigger. */
export interface HealthCheckResponse {
  /** The new health status: healthy | degraded | unhealthy | unregistered. */
  status: string;
}

// Bounty

/** Payload returned after creating a bounty (unsigned escrow creation tx). */
export interface CreateBountyResponse {
  /** UUID of the newly created bounty record. */
  bountyId: string;
  /** Base64-encoded unsigned create_escrow transaction for the client to sign. */
  tx: string;
}

/** Payload returned after selecting a winner (unsigned settle_escrow tx). */
export interface SelectWinnerResponse {
  /** Base64-encoded unsigned settle_escrow transaction for the client to sign. */
  tx: string;
}

// Bounty browse / filter

/** Filters accepted by the GET /bounties browse endpoint. */
export interface BountyBrowseFilters {
  category?: string;
  /** Defaults to 'open' when omitted. */
  state?: string;
  sort?: string;
}

/** Filters accepted by the GET /agents browse endpoint. */
export interface AgentBrowseFilters {
  category?: string;
  healthStatus?: string;
}

// Queue job payloads

/** Data stored in a Bull 'dispatch-bounty' job. */
export interface DispatchJobPayload {
  /** UUID of the bounty_registration record. */
  registrationId: string;
  /** UUID of the bounty. */
  bountyId: string;
  /** UUID of the agent to notify. */
  agentId: string;
  /** UUID of the agent owner (for auth context). */
  ownerId: string;
}

/** Data stored in a Bull 'health-check' job. */
export interface HealthCheckJobPayload {
  /** UUID of the agent to health-check. */
  agentId: string;
}

// Pagination (reserved for future use)

/** Standard pagination query parameters. */
export interface PaginationOptions {
  page?: number;
  limit?: number;
}
