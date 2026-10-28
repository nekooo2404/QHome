import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface SecurityPassPayload {
  jti: string;
  projectId: string;
  requestId: string;
  residentId: string;
  type: string;
  validFrom: number;
  expiresAt: number;
}

export class SecurityQrPassService {
  constructor(private readonly secret: string, private readonly clock = () => Date.now()) {
    if (secret.length < 32) throw new Error('SECURITY_PASS_HMAC_SECRET must be at least 32 characters');
  }

  issue(input: Omit<SecurityPassPayload, 'jti' | 'validFrom' | 'expiresAt'> & { ttlMs: number }): { token: string; payload: SecurityPassPayload } {
    const payload: SecurityPassPayload = { ...input, jti: randomUUID(), validFrom: this.clock(), expiresAt: this.clock() + input.ttlMs };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { payload, token: encoded + '.' + this.sign(encoded) };
  }

  verify(token: string): SecurityPassPayload {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) throw new Error('Invalid security pass');
    const expected = Buffer.from(this.sign(encoded), 'hex');
    const provided = Buffer.from(signature, 'hex');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new Error('Invalid security pass signature');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SecurityPassPayload;
    const now = this.clock();
    if (payload.validFrom > now || payload.expiresAt <= now) throw new Error('Security pass is outside validity window');
    return payload;
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret).update(encoded, 'utf8').digest('hex');
  }
}
