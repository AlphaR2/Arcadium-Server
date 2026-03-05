import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Validates that the request carries a valid Ed25519 wallet signature.
 * Expects body: { pubkey: string, signature: string (base58), nonce: string }
 */
@Injectable()
export class WalletAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const { pubkey, signature, nonce } = req.body as {
      pubkey: string;
      signature: string;
      nonce: string;
    };

    if (!pubkey || !signature || !nonce) {
      throw new UnauthorizedException('Missing pubkey, signature, or nonce');
    }

    try {
      const messageBytes = Buffer.from(nonce, 'utf-8');
      const signatureBytes = bs58.decode(signature);
      const pubkeyBytes = bs58.decode(pubkey);

      const valid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        pubkeyBytes,
      );

      if (!valid) throw new UnauthorizedException('Invalid wallet signature');
    } catch {
      throw new UnauthorizedException('Signature verification failed');
    }

    return true;
  }
}
