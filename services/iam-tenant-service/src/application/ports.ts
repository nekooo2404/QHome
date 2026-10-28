import { AuthenticatedUser, SessionRecord, TenantMembership, UserStatus, UserType } from '../domain/auth';
import { PermissionGrant, PermissionMatrix } from '../domain/authorization';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface TokenHasher {
  hash(token: string): string;
}

export interface AccessTokenSigner {
  sign(claims: {
    userId: string;
    tenantId: string;
    userType: UserType;
    sessionId: string;
    authorizationVersion: string;
    scopes: string[];
  }): Promise<string>;
}

export interface RefreshTokenGenerator {
  generate(): string;
}

export interface JwksProvider {
  getJwks(): Promise<{ keys: Array<Record<string, string>> }>;
}

export interface LoginAttemptRateLimiter {
  consume(key: string, now: Date): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

export interface SessionRevocationStore {
  revoke(sessionId: string, ttlSeconds: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface AuthUserRecord extends AuthenticatedUser {
  membership: TenantMembership | null;
}

export interface RefreshRotationInput {
  presentedTokenHash: string;
  newTokenId: string;
  newTokenHash: string;
  newExpiresAt: Date;
  now: Date;
  securityEvent?: {
    eventId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
    correlationId?: string;
  };
}

export type RefreshRotationResult =
  | {
      status: 'ROTATED';
      user: AuthenticatedUser;
      membership: TenantMembership;
      session: SessionRecord;
    }
  | { status: 'INVALID' }
  | { status: 'REUSE_DETECTED'; familyId: string; sessionId: string; projectId: string };

export interface AuthRepository {
  findUserForLogin(emailNormalized: string, projectId: string): Promise<AuthUserRecord | null>;
  findUserByIdForSession(userId: string, projectId: string): Promise<AuthUserRecord | null>;
  recordFailedLogin(userId: string, now: Date, lockThreshold: number, lockDurationMs: number): Promise<void>;
  recordSuccessfulLogin(userId: string, now: Date): Promise<void>;
  createSessionWithRefreshToken(input: {
    userId: string;
    membershipId: string;
    projectId: string;
    deviceId: string;
    userAgentHash?: string;
    ipHash?: string;
    refreshTokenId: string;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<SessionRecord>;
  rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult>;
  revokeSession(sessionId: string, userId: string, now: Date): Promise<void>;
  revokeAllSessions(userId: string, now: Date): Promise<string[]>;
  getAuthorizationMatrix(userId: string, projectId: string): Promise<PermissionMatrix | null>;
  getTenantContext(userId: string, projectId: string): Promise<PermissionMatrix | null>;
  replaceUserPermissionOverride(input: {
    projectId: string;
    userId: string;
    permission: string;
    effect: 'ALLOW' | 'DENY';
    buildingId?: string;
    event: {
      eventId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      projectId: string;
      occurredAt: Date;
      payload: Record<string, unknown>;
      correlationId?: string;
    };
  }): Promise<string>;
}

export interface PermissionCache {
  get(userId: string, projectId: string): Promise<PermissionMatrix | null>;
  set(userId: string, projectId: string, matrix: PermissionMatrix, ttlSeconds: number): Promise<void>;
  invalidate(userId: string, projectId: string, version: string): Promise<void>;
}

export interface EventPublisher {
  publish(event: {
    eventId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    projectId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
    correlationId?: string;
  }): Promise<void>;
}

export interface AuthorizationVersionStore {
  next(userId: string, projectId: string): Promise<string>;
}

export interface UserScopeSnapshot {
  userId: string;
  projectId: string;
  status: UserStatus;
  userType: UserType;
}

export interface TenantAdminContext {
  actorUserId: string;
  projectId: string;
  authenticatedTenantId: string;
  sessionId?: string;
  correlationId: string;
}

export interface TenantAdminRepository {
  createProject(input: { code: string; name: string; actorUserId: string; correlationId: string }): Promise<{ id: string; code: string; name: string; status: string }>;
  createBuilding(input: { projectId: string; code: string; name: string; actorUserId: string; correlationId: string }): Promise<{ id: string; projectId: string; code: string; name: string; status: string }>;
  createDepartment(input: { projectId: string; code: string; name: string; description?: string; actorUserId: string; correlationId: string }): Promise<{ id: string; projectId: string; code: string; name: string; isActive: boolean }>;
  provisionUser(input: { projectId: string; emailNormalized: string; displayName: string; userType: UserType; passwordHash: string; apartmentId?: string; buildingIds: string[]; actorUserId: string; correlationId: string }): Promise<{ userId: string; membershipId: string; projectId: string; emailNormalized: string; status: string }>;
  assignRole(input: { projectId: string; userId: string; roleCode: string; buildingIds: string[]; actorUserId: string; correlationId: string }): Promise<{ userId: string; projectId: string; authorizationVersion: string }>;
  addDepartmentMember(input: { projectId: string; departmentCode: string; userId: string; actorUserId: string; correlationId: string }): Promise<{ userId: string; projectId: string; authorizationVersion: string }>;
  bindDepartmentRole(input: { projectId: string; departmentCode: string; roleCode: string; actorUserId: string; correlationId: string }): Promise<{ authorizationVersions: Array<{ userId: string; version: string }>; projectId: string }>;
}
