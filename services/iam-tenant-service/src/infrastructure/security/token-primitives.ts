import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { RefreshTokenGenerator, TokenHasher } from '../../application/ports';

export class HmacSha256TokenHasher implements TokenHasher {
  constructor(private readonly pepper: string) {
    if (pepper.length < 32) throw new Error('IAM_TOKEN_PEPPER must be at least 32 characters');
  }

  hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token, 'utf8').digest('hex');
  }
}

export class RandomOpaqueTokenGenerator implements RefreshTokenGenerator {
  generate(): string {
    return randomBytes(48).toString('base64url');
  }
}

export class UuidGenerator {
  next(): string {
    return randomUUID();
  }
}

export class SystemClock {
  now(): Date {
    return new Date();
  }
}
