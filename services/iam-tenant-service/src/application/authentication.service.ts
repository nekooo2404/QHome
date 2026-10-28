import {
  AccessTokenSigner,
  AuthRepository,
  Clock,
  IdGenerator,
  LoginAttemptRateLimiter,
  SessionRevocationStore,
  PasswordHasher,
  RefreshTokenGenerator,
  TokenHasher,
} from './ports';
import {
  AccessTokenClaims,
  AccountLockedError,
  AuthenticationRateLimitedError,
  InvalidCredentialsError,
  RefreshTokenInvalidError,
  RefreshTokenReuseDetectedError,
  UserSuspendedError,
  normalizeEmail,
} from '../domain/auth';
import { PermissionMatrix } from '../domain/authorization';

export interface LoginCommand {
  projectId: string;
  email: string;
  password: string;
  deviceId: string;
  ipHash?: string;
  userAgentHash?: string;
}

export interface AuthenticationResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export interface RefreshCommand {
  refreshToken: string;
}

export interface AuthenticationServiceOptions {
  accessTokenExpiresInSeconds: number;
  refreshTokenTtlMs: number;
  lockThreshold: number;
  lockDurationMs: number;
  dummyPasswordHash: string;
}

export class AuthenticationService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenHasher: TokenHasher,
    private readonly accessTokenSigner: AccessTokenSigner,
    private readonly refreshTokenGenerator: RefreshTokenGenerator,
    private readonly rateLimiter: LoginAttemptRateLimiter,
    private readonly sessionRevocation: SessionRevocationStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: AuthenticationServiceOptions,
  ) {}

  async login(command: LoginCommand): Promise<AuthenticationResult> {
    if (!command.projectId?.trim() || command.projectId.length > 128 || !command.deviceId?.trim() || command.deviceId.length > 160) throw new InvalidCredentialsError();
    const email = normalizeEmail(command.email);
    await this.consumeLoginLimit(`project:${command.projectId}:email:${email}`);
    if (command.ipHash) {
      await this.consumeLoginLimit(`project:${command.projectId}:ip:${command.ipHash}`);
    }

    const now = this.clock.now();
    const record = await this.repository.findUserForLogin(email, command.projectId);
    const passwordHash = record?.passwordHash ?? this.options.dummyPasswordHash;
    const passwordMatches = await this.passwordHasher.verify(passwordHash, command.password);

    if (!record || !passwordMatches) {
      if (record) {
        await this.repository.recordFailedLogin(
          record.id,
          now,
          this.options.lockThreshold,
          this.options.lockDurationMs,
        );
      }
      throw new InvalidCredentialsError();
    }

    if (record.lockedUntil && record.lockedUntil.getTime() > now.getTime()) {
      throw new AccountLockedError(record.lockedUntil.getTime() - now.getTime());
    }
    const expiredTemporaryLock = record.status === 'LOCKED'
      && record.lockedUntil !== null
      && record.lockedUntil.getTime() <= now.getTime();
    if ((!['ACTIVE', 'LOCKED'].includes(record.status) || (record.status === 'LOCKED' && !expiredTemporaryLock))
      || !record.membership
      || record.membership.status !== 'ACTIVE') {
      throw new UserSuspendedError();
    }

    await this.repository.recordSuccessfulLogin(record.id, now);
    const refreshToken = this.refreshTokenGenerator.generate();
    const refreshExpiresAt = new Date(now.getTime() + this.options.refreshTokenTtlMs);
    const session = await this.repository.createSessionWithRefreshToken({
      userId: record.id,
      membershipId: record.membership.id,
      projectId: record.membership.projectId,
      deviceId: command.deviceId,
      ipHash: command.ipHash,
      userAgentHash: command.userAgentHash,
      refreshTokenId: this.ids.next(),
      refreshTokenHash: this.tokenHasher.hash(refreshToken),
      refreshExpiresAt,
      now,
    });

    const matrix = await this.repository.getAuthorizationMatrix(record.id, record.membership.projectId);
    return this.issueTokens(record, record.membership.projectId, session.id, refreshToken, refreshExpiresAt, matrix);
  }

  async refresh(command: RefreshCommand): Promise<AuthenticationResult> {
    if (!command.refreshToken || command.refreshToken.length < 40 || command.refreshToken.length > 512) {
      throw new RefreshTokenInvalidError();
    }
    const now = this.clock.now();
    const nextRefreshToken = this.refreshTokenGenerator.generate();
    const nextExpiresAt = new Date(now.getTime() + this.options.refreshTokenTtlMs);
    const result = await this.repository.rotateRefreshToken({
      presentedTokenHash: this.tokenHasher.hash(command.refreshToken),
      newTokenId: this.ids.next(),
      newTokenHash: this.tokenHasher.hash(nextRefreshToken),
      newExpiresAt: nextExpiresAt,
      now,
      securityEvent: {
        eventId: this.ids.next(),
        eventType: 'iam.security.refresh_token_reuse_detected.v1',
        aggregateType: 'refresh_token_family',
        aggregateId: 'resolved-in-transaction',
        occurredAt: now,
        payload: { reason: 'refresh_token_reuse_detected' },
      },
    });

    if (result.status === 'REUSE_DETECTED') {
      await this.sessionRevocation.revoke(result.sessionId, this.options.accessTokenExpiresInSeconds);
      throw new RefreshTokenReuseDetectedError();
    }
    if (result.status === 'INVALID') {
      throw new RefreshTokenInvalidError();
    }

    const matrix = await this.repository.getAuthorizationMatrix(result.user.id, result.membership.projectId);
    return this.issueTokens(
      result.user,
      result.membership.projectId,
      result.session.id,
      nextRefreshToken,
      nextExpiresAt,
      matrix,
    );
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, userId, this.clock.now());
    await this.sessionRevocation.revoke(sessionId, this.options.accessTokenExpiresInSeconds);
  }

  async logoutAll(userId: string): Promise<void> {
    const sessionIds = await this.repository.revokeAllSessions(userId, this.clock.now());
    await Promise.all(sessionIds.map((sessionId) => this.sessionRevocation.revoke(sessionId, this.options.accessTokenExpiresInSeconds)));
  }

  private async consumeLoginLimit(key: string): Promise<void> {
    let result: { allowed: boolean; retryAfterMs: number };
    try {
      result = await this.rateLimiter.consume(key, this.clock.now());
    } catch {
      throw new AuthenticationRateLimitedError(1000);
    }
    if (!result.allowed) {
      throw new AuthenticationRateLimitedError(result.retryAfterMs);
    }
  }

  private async issueTokens(
    user: { id: string; userType: 'BQL' | 'RESIDENT' },
    projectId: string,
    sessionId: string,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
    matrix: PermissionMatrix | null,
  ): Promise<AuthenticationResult> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      tenantId: projectId,
      userType: user.userType,
      sessionId,
      authorizationVersion: matrix?.version ?? '0',
      scopes: matrix ? Array.from(new Set(matrix.grants.filter((grant) => grant.effect === 'ALLOW').map((grant) => grant.permission))) : [],
    };
    const accessToken = await this.accessTokenSigner.sign({
      userId: claims.sub,
      tenantId: claims.tenantId,
      userType: claims.userType,
      sessionId: claims.sessionId,
      authorizationVersion: claims.authorizationVersion,
      scopes: claims.scopes,
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      accessTokenExpiresInSeconds: this.options.accessTokenExpiresInSeconds,
      refreshTokenExpiresAt,
      sessionId,
    };
  }
}
