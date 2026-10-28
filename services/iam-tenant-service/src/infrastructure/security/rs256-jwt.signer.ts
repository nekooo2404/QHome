import { createPrivateKey, createPublicKey, createSign, KeyObject, randomUUID } from 'node:crypto';
import { AccessTokenSigner, JwksProvider } from '../../application/ports';

function base64urlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export interface Rs256JwtSignerOptions {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
  issuer: string;
  audience: string;
  accessTokenExpiresInSeconds: number;
}

export class Rs256JwtSigner implements AccessTokenSigner, JwksProvider {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(private readonly options: Rs256JwtSignerOptions) {
    if (options.accessTokenExpiresInSeconds < 60 || options.accessTokenExpiresInSeconds > 900) {
      throw new Error('Access token lifetime must be between 60 and 900 seconds');
    }
    this.privateKey = createPrivateKey(options.privateKeyPem);
    this.publicKey = createPublicKey(options.publicKeyPem);
  }

  async sign(claims: {
    userId: string;
    tenantId: string;
    userType: 'BQL' | 'RESIDENT';
    sessionId: string;
    authorizationVersion: string;
    scopes: string[];
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: this.options.keyId };
    const payload = {
      iss: this.options.issuer,
      aud: this.options.audience,
      sub: claims.userId,
      iat: now,
      exp: now + this.options.accessTokenExpiresInSeconds,
      jti: `${claims.sessionId}.${randomUUID()}`,
      tenant_id: claims.tenantId,
      user_type: claims.userType,
      session_id: claims.sessionId,
      authorization_version: claims.authorizationVersion,
      scope: claims.scopes.join(' '),
    };
    const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(this.privateKey).toString('base64url')}`;
  }

  async getJwks(): Promise<{ keys: Array<Record<string, string>> }> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
    return {
      keys: [{
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        use: 'sig',
        alg: 'RS256',
        kid: this.options.keyId,
      }],
    };
  }
}
