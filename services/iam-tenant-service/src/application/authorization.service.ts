import { IdGenerator, AuthRepository, PermissionCache, SessionRevocationStore } from './ports';
import { AuthorizationRequest, AuthorizationDecision, PermissionMatrix, evaluatePermission, assertTenantContext } from '../domain/authorization';

export interface PermissionOverrideCommand {
  projectId: string;
  userId: string;
  permission: string;
  effect: 'ALLOW' | 'DENY';
  buildingId?: string;
  correlationId?: string;
  actorUserId?: string;
  authenticatedTenantId?: string;
  sessionId?: string;
}

export class AuthorizationService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly permissionCache: PermissionCache,
    private readonly ids: IdGenerator,
    private readonly sessionRevocation: SessionRevocationStore,
    private readonly cacheTtlSeconds = 60,
  ) {}

  async verifyPermission(
    request: AuthorizationRequest,
    authenticatedTenantId: string,
  ): Promise<AuthorizationDecision> {
    assertTenantContext(request.projectId, authenticatedTenantId);
    if (request.sessionId && await this.sessionRevocation.isRevoked(request.sessionId)) {
      return { allowed: false, reason: 'SESSION_REVOKED', authorizationVersion: '0' };
    }
    const matrix = await this.loadMatrix(request.userId, request.projectId);
    return evaluatePermission(matrix, request);
  }

  async getTenantContext(userId: string, projectId: string, authenticatedTenantId: string, sessionId?: string): Promise<PermissionMatrix> {
    assertTenantContext(projectId, authenticatedTenantId);
    if (sessionId && await this.sessionRevocation.isRevoked(sessionId)) return { version: '0', staffScope: false, grants: [], buildingIds: [], apartmentIds: [] };
    const matrix = await this.loadMatrix(userId, projectId);
    if (!matrix) {
      return {
        version: '0',
        staffScope: false,
        staffScope: false,
        grants: [],
        buildingIds: [],
        apartmentIds: [],
      };
    }
    return matrix;
  }

  async replacePermissionOverride(command: PermissionOverrideCommand): Promise<void> {
    if (!command.projectId || !command.userId || !command.permission) {
      throw new Error('projectId, userId and permission are required');
    }
    if (!command.actorUserId || !command.authenticatedTenantId) throw new Error('authenticated actor context is required');
    await this.requirePermission(command.actorUserId, command.projectId, 'iam.permission.override', command.authenticatedTenantId, command.buildingId, undefined, command.sessionId);
    const occurredAt = new Date();
    const version = await this.repository.replaceUserPermissionOverride({
      ...command,
      event: {
        eventId: this.ids.next(),
        eventType: 'iam.authorization.permission_override_changed.v1',
        aggregateType: 'user_permission_override',
        aggregateId: `${command.userId}:${command.projectId}:${command.permission}:${command.buildingId ?? 'project'}`,
        projectId: command.projectId,
        occurredAt,
        correlationId: command.correlationId,
        payload: {
          userId: command.userId,
          projectId: command.projectId,
          permission: command.permission,
          effect: command.effect,
          buildingId: command.buildingId ?? null,
        },
      },
    });
    await this.permissionCache.invalidate(command.userId, command.projectId, version);
  }

  async requirePermission(userId: string, projectId: string, permission: string, authenticatedTenantId: string, buildingId?: string, apartmentId?: string, sessionId?: string): Promise<void> {
    const decision = await this.verifyPermission({ userId, projectId, permission, buildingId, apartmentId, sessionId }, authenticatedTenantId);
    if (!decision.allowed) throw new Error(`Permission denied: ${decision.reason}`);
  }

  private async loadMatrix(userId: string, projectId: string): Promise<PermissionMatrix | null> {
    const cached = await this.permissionCache.get(userId, projectId);
    if (cached) {
      return cached;
    }
    const matrix = await this.repository.getAuthorizationMatrix(userId, projectId);
    if (matrix) {
      await this.permissionCache.set(userId, projectId, matrix, this.cacheTtlSeconds);
    }
    return matrix;
  }
}
