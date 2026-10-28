import { assertPasswordForProvisioning, normalizeEmail, UserType } from '../domain/auth';
import { AuthorizationService } from './authorization.service';
import { PasswordHasher, PermissionCache, TenantAdminContext, TenantAdminRepository } from './ports';

export class TenantAdministrationService {
  constructor(
    private readonly repository: TenantAdminRepository,
    private readonly authorization: AuthorizationService,
    private readonly passwordHasher: PasswordHasher,
    private readonly permissionCache: PermissionCache,
  ) {}

  async createProject(context: TenantAdminContext, input: { code: string; name: string }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.project.manage', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    return this.repository.createProject({ ...input, actorUserId: context.actorUserId, correlationId: context.correlationId });
  }

  async createBuilding(context: TenantAdminContext, input: { code: string; name: string }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.building.manage', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    return this.repository.createBuilding({ ...input, projectId: context.projectId, actorUserId: context.actorUserId, correlationId: context.correlationId });
  }

  async createDepartment(context: TenantAdminContext, input: { code: string; name: string; description?: string }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.department.manage', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    return this.repository.createDepartment({ ...input, projectId: context.projectId, actorUserId: context.actorUserId, correlationId: context.correlationId });
  }

  async provisionUser(context: TenantAdminContext, input: { email: string; displayName: string; userType: UserType; password: string; apartmentId?: string; buildingIds?: string[] }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.user.manage', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    assertPasswordForProvisioning(input.password);
    const passwordHash = await this.passwordHasher.hash(input.password);
    return this.repository.provisionUser({ projectId: context.projectId, emailNormalized: normalizeEmail(input.email), displayName: input.displayName.trim(), userType: input.userType, passwordHash, apartmentId: input.apartmentId, buildingIds: input.buildingIds ?? [], actorUserId: context.actorUserId, correlationId: context.correlationId });
  }

  async assignRole(context: TenantAdminContext, input: { userId: string; roleCode: string; buildingIds?: string[] }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.role.assign', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    const result = await this.repository.assignRole({ projectId: context.projectId, userId: input.userId, roleCode: input.roleCode, buildingIds: input.buildingIds ?? [], actorUserId: context.actorUserId, correlationId: context.correlationId });
    await this.permissionCache.invalidate(result.userId, result.projectId, result.authorizationVersion);
    return result;
  }

  async addDepartmentMember(context: TenantAdminContext, input: { departmentCode: string; userId: string }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.department.manage', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    const result = await this.repository.addDepartmentMember({ projectId: context.projectId, ...input, actorUserId: context.actorUserId, correlationId: context.correlationId });
    await this.permissionCache.invalidate(result.userId, result.projectId, result.authorizationVersion);
    return result;
  }

  async bindDepartmentRole(context: TenantAdminContext, input: { departmentCode: string; roleCode: string }) {
    await this.authorization.requirePermission(context.actorUserId, context.projectId, 'iam.role.assign', context.authenticatedTenantId, undefined, undefined, context.sessionId);
    const result = await this.repository.bindDepartmentRole({ projectId: context.projectId, ...input, actorUserId: context.actorUserId, correlationId: context.correlationId });
    await Promise.all(result.authorizationVersions.map((entry) => this.permissionCache.invalidate(entry.userId, result.projectId, entry.version)));
    return result;
  }
}
