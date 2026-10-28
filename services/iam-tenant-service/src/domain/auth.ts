export type UserType = 'BQL' | 'RESIDENT';
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DEACTIVATED';

export class InvalidCredentialsError extends Error {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid credentials');
  }
}

export class AuthenticationRateLimitedError extends Error {
  readonly code = 'AUTH_RATE_LIMITED';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Too many authentication attempts');
    this.retryAfterMs = retryAfterMs;
  }
}

export class AccountLockedError extends Error {
  readonly code = 'ACCOUNT_LOCKED';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Account is temporarily locked');
    this.retryAfterMs = retryAfterMs;
  }
}

export class RefreshTokenInvalidError extends Error {
  readonly code = 'REFRESH_TOKEN_INVALID';

  constructor() {
    super('Refresh token is invalid or expired');
  }
}

export class RefreshTokenReuseDetectedError extends Error {
  readonly code = 'REFRESH_TOKEN_REUSE_DETECTED';

  constructor() {
    super('Refresh token reuse detected');
  }
}

export class UserSuspendedError extends Error {
  readonly code = 'USER_SUSPENDED';

  constructor() {
    super('User account is not active');
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) || normalized.length > 320) {
    throw new InvalidCredentialsError();
  }
  return normalized;
}

export function assertPasswordForProvisioning(password: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters');
  }
  if (!/[a-z]/u.test(password) || !/[A-Z]/u.test(password) || !/[0-9]/u.test(password)) {
    throw new Error('Password must include lowercase, uppercase, and numeric characters');
  }
}

export interface AuthenticatedUser {
  id: string;
  emailNormalized: string;
  displayName: string;
  userType: UserType;
  status: UserStatus;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
}

export interface TenantMembership {
  id: string;
  projectId: string;
  userId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  apartmentId: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  membershipId: string;
  projectId: string;
  deviceId: string;
  status: 'ACTIVE' | 'REVOKED';
}

export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  userType: UserType;
  sessionId: string;
  authorizationVersion: string;
  scopes: string[];
}
