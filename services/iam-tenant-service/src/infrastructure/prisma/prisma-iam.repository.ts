import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuthRepository, AuthUserRecord, RefreshRotationInput, RefreshRotationResult, TenantAdminRepository } from '../../application/ports';
import { AuthenticatedUser, SessionRecord, TenantMembership } from '../../domain/auth';
import { PermissionGrant, PermissionMatrix } from '../../domain/authorization';

type TransactionClient = Prisma.TransactionClient;

function toUser(record: {
  id: string;
  emailNormalized: string;
  displayName: string;
  userType: 'BQL' | 'RESIDENT';
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DEACTIVATED';
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
}): AuthenticatedUser {
  return {
    id: record.id,
    emailNormalized: record.emailNormalized,
    displayName: record.displayName,
    userType: record.userType,
    status: record.status,
    passwordHash: record.passwordHash,
    failedLoginCount: record.failedLoginCount,
    lockedUntil: record.lockedUntil,
    lastLoginAt: record.lastLoginAt,
  };
}

function toMembership(record: {
  id: string;
  projectId: string;
  userId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  apartmentId: string | null;
}): TenantMembership {
  return {
    id: record.id,
    projectId: record.projectId,
    userId: record.userId,
    status: record.status,
    apartmentId: record.apartmentId,
  };
}

function adminOutbox(projectId: string | undefined, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, occurredAt: Date) {
  return { eventId: randomUUID(), projectId, eventType, aggregateType, aggregateId, payload, headers: {}, occurredAt };
}

export class PrismaIamRepository implements AuthRepository, TenantAdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserForLogin(emailNormalized: string, projectId: string): Promise<AuthUserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized },
      include: {
        memberships: { where: { projectId }, take: 1 },
      },
    });
    if (!user) return null;
    return {
      ...toUser(user),
      membership: user.memberships[0] ? toMembership(user.memberships[0]) : null,
    };
  }

  async findUserByIdForSession(userId: string, projectId: string): Promise<AuthUserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { where: { projectId }, take: 1 },
      },
    });
    if (!user) return null;
    return {
      ...toUser(user),
      membership: user.memberships[0] ? toMembership(user.memberships[0]) : null,
    };
  }

  async recordFailedLogin(userId: string, now: Date, lockThreshold: number, lockDurationMs: number): Promise<void> {
    await this.withSerializableRetry(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { failedLoginCount: true } });
      if (!user) return;
      const nextCount = user.failedLoginCount + 1;
      await tx.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: nextCount,
          lockedUntil: nextCount >= lockThreshold ? new Date(now.getTime() + lockDurationMs) : undefined,
          status: nextCount >= lockThreshold ? 'LOCKED' : undefined,
        },
      });
    });
  }

  async recordSuccessfulLogin(userId: string, now: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, status: 'ACTIVE' },
    });
  }

  async createSessionWithRefreshToken(input: {
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
  }): Promise<SessionRecord> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.authSession.create({
        data: {
          id: randomUUID(),
          userId: input.userId,
          membershipId: input.membershipId,
          deviceId: input.deviceId,
          userAgentHash: input.userAgentHash,
          ipHash: input.ipHash,
          lastSeenAt: input.now,
          tokenFamily: {
            create: {
              id: randomUUID(),
              userId: input.userId,
              tokens: {
                create: {
                  id: input.refreshTokenId,
                  userId: input.userId,
                  tokenHash: input.refreshTokenHash,
                  expiresAt: input.refreshExpiresAt,
                },
              },
            },
          },
        },
      });
      return {
        id: session.id,
        userId: session.userId,
        membershipId: session.membershipId,
        projectId: input.projectId,
        deviceId: session.deviceId,
        status: 'ACTIVE',
      };
    });
  }

  async rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult> {
    return this.withSerializableRetry(async (tx) => {
      const token = await tx.refreshToken.findUnique({
        where: { tokenHash: input.presentedTokenHash },
        include: {
          family: {
            include: {
              session: { include: { membership: true } },
            },
          },
          user: true,
        },
      });
      if (!token) return { status: 'INVALID' };

      if (token.usedAt || token.revokedAt) {
        await this.revokeFamily(tx, token.familyId, input.now);
        if (input.securityEvent) {
          await tx.outboxEvent.create({
            data: {
              eventId: input.securityEvent.eventId,
              projectId: token.family.session.membership.projectId,
              eventType: input.securityEvent.eventType,
              aggregateType: input.securityEvent.aggregateType,
              aggregateId: token.familyId,
              payload: input.securityEvent.payload,
              headers: input.securityEvent.correlationId ? { correlationId: input.securityEvent.correlationId } : {},
              occurredAt: input.securityEvent.occurredAt,
            },
          });
        }
        return {
          status: 'REUSE_DETECTED',
          familyId: token.familyId,
          sessionId: token.family.sessionId,
          projectId: token.family.session.membership.projectId,
        };
      }
      if (token.expiresAt <= input.now || token.family.revokedAt || token.family.session.revokedAt || token.family.session.status !== 'ACTIVE') {
        return { status: 'INVALID' };
      }

      const consumed = await tx.refreshToken.updateMany({
        where: { id: token.id, usedAt: null, revokedAt: null },
        data: { usedAt: input.now, replacedById: input.newTokenId },
      });
      if (consumed.count !== 1) {
        await this.revokeFamily(tx, token.familyId, input.now);
        if (input.securityEvent) {
          await tx.outboxEvent.create({
            data: {
              eventId: input.securityEvent.eventId,
              projectId: token.family.session.membership.projectId,
              eventType: input.securityEvent.eventType,
              aggregateType: input.securityEvent.aggregateType,
              aggregateId: token.familyId,
              payload: input.securityEvent.payload,
              headers: input.securityEvent.correlationId ? { correlationId: input.securityEvent.correlationId } : {},
              occurredAt: input.securityEvent.occurredAt,
            },
          });
        }
        return {
          status: 'REUSE_DETECTED',
          familyId: token.familyId,
          sessionId: token.family.sessionId,
          projectId: token.family.session.membership.projectId,
        };
      }

      await tx.refreshToken.create({
        data: {
          id: input.newTokenId,
          familyId: token.familyId,
          userId: token.userId,
          tokenHash: input.newTokenHash,
          parentId: token.id,
          expiresAt: input.newExpiresAt,
        },
      });
      await tx.authSession.update({
        where: { id: token.family.sessionId },
        data: { lastSeenAt: input.now },
      });
      return {
        status: 'ROTATED',
        user: toUser(token.user),
        membership: toMembership(token.family.session.membership),
        session: {
          id: token.family.session.id,
          userId: token.userId,
          membershipId: token.family.session.membershipId,
          projectId: token.family.session.membership.projectId,
          deviceId: token.family.session.deviceId,
          status: 'ACTIVE',
        },
      };
    });
  }

  async revokeSession(sessionId: string, userId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.authSession.updateMany({
        where: { id: sessionId, userId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now },
      });
      if (revoked.count !== 1) return;
      const family = await tx.refreshTokenFamily.findUnique({ where: { sessionId } });
      if (!family) return;
      await tx.refreshTokenFamily.update({ where: { id: family.id }, data: { revokedAt: now } });
      await tx.refreshToken.updateMany({ where: { familyId: family.id, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  async revokeAllSessions(userId: string, now: Date): Promise<string[]> {
    const sessions = await this.prisma.authSession.findMany({ where: { userId, status: 'ACTIVE' }, select: { id: true } });
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({ where: { userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } }),
      this.prisma.refreshTokenFamily.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
    return sessions.map((session) => session.id);
  }

  async getAuthorizationMatrix(userId: string, projectId: string): Promise<PermissionMatrix | null> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { scopes: true },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;

    const [assignments, departments, overrides] = await Promise.all([
      this.prisma.roleAssignment.findMany({
        where: { userId, projectId, revokedAt: null },
        include: { role: { include: { permissions: { include: { permission: true } } } }, scopes: true },
      }),
      this.prisma.departmentMember.findMany({
        where: { userId, removedAt: null, department: { projectId, isActive: true } },
        include: {
          department: {
            include: {
              roleBindings: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            },
          },
        },
      }),
      this.prisma.userPermissionOverride.findMany({
        where: { userId, projectId },
        include: { permission: true },
      }),
    ]);

    const grants: PermissionGrant[] = [];
    const addRoleGrants = (role: { permissions: Array<{ permission: { code: string } }> }, source: PermissionGrant['source'], scopes: Array<{ scopeType: 'PROJECT' | 'BUILDING'; buildingId: string | null }>) => {
      const effectiveScopes = scopes.length > 0 ? scopes : [{ scopeType: 'PROJECT' as const, buildingId: null }];
      for (const rolePermission of role.permissions) {
        for (const scope of effectiveScopes) {
          grants.push({
            permission: rolePermission.permission.code,
            effect: 'ALLOW',
            source,
            scope: scope.scopeType === 'PROJECT'
              ? { type: 'PROJECT', projectId }
              : { type: 'BUILDING', projectId, buildingId: scope.buildingId as string },
          });
        }
      }
    };

    for (const assignment of assignments) addRoleGrants(assignment.role, assignment.source === 'DEPARTMENT' ? 'DEPARTMENT_ROLE' : 'ROLE', assignment.scopes);
    for (const member of departments) for (const binding of member.department.roleBindings) addRoleGrants(binding.role, 'DEPARTMENT_ROLE', membership.scopes.map((scope) => ({ scopeType: 'BUILDING' as const, buildingId: scope.buildingId })));
    for (const override of overrides) {
      grants.push({
        permission: override.permission.code,
        effect: override.effect,
        source: 'USER_OVERRIDE',
        scope: override.scopeType === 'PROJECT'
          ? { type: 'PROJECT', projectId }
          : { type: 'BUILDING', projectId, buildingId: override.buildingId as string },
      });
    }

    return {
      version: String(membership.version),
      staffScope: user.userType === 'BQL',
      grants,
      buildingIds: membership.scopes.map((scope) => scope.buildingId),
      apartmentIds: membership.scopes.flatMap((scope) => scope.apartmentId ? [scope.apartmentId] : []),
    };
  }

  async getTenantContext(userId: string, projectId: string): Promise<PermissionMatrix | null> {
    return this.getAuthorizationMatrix(userId, projectId);
  }

  async replaceUserPermissionOverride(input: {
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
  }): Promise<string> {
    return this.withSerializableRetry(async (tx) => {
      const membership = await tx.projectMembership.findUnique({ where: { projectId_userId: { projectId: input.projectId, userId: input.userId } } });
      if (!membership || membership.status !== 'ACTIVE') throw new Error('User is not an active project member');
      const permission = await tx.permission.findUnique({ where: { code: input.permission } });
      if (!permission) throw new Error('Permission does not exist');
      if (input.buildingId) {
        const building = await tx.building.findFirst({ where: { id: input.buildingId, projectId: input.projectId, status: 'ACTIVE' } });
        if (!building) throw new Error('Building is outside the project scope');
      }
      const scopeKey = input.buildingId ? `BUILDING:${input.buildingId}` : 'PROJECT';
      await tx.userPermissionOverride.upsert({
        where: {
          userId_projectId_permissionId_scopeKey: {
            userId: input.userId,
            projectId: input.projectId,
            permissionId: permission.id,
            scopeKey,
          },
        },
        create: {
          projectId: input.projectId,
          userId: input.userId,
          permissionId: permission.id,
          effect: input.effect,
          scopeType: input.buildingId ? 'BUILDING' : 'PROJECT',
          buildingId: input.buildingId,
          scopeKey,
        },
        update: { effect: input.effect, buildingId: input.buildingId, scopeType: input.buildingId ? 'BUILDING' : 'PROJECT' },
      });
      const updatedMembership = await tx.projectMembership.update({ where: { id: membership.id }, data: { version: { increment: 1 } }, select: { version: true } });
      await tx.outboxEvent.create({
        data: {
          eventId: input.event.eventId,
          projectId: input.event.projectId,
          eventType: input.event.eventType,
          aggregateType: input.event.aggregateType,
          aggregateId: input.event.aggregateId,
          payload: { ...input.event.payload, authorizationVersion: String(updatedMembership.version) },
          headers: input.event.correlationId ? { correlationId: input.event.correlationId } : {},
          occurredAt: input.event.occurredAt,
        },
      });
      return String(updatedMembership.version);
    });
  }

  async createProject(input: { code: string; name: string; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const project = await tx.project.create({ data: { code: input.code.trim(), name: input.name.trim() } });
      const occurredAt = new Date();
      await tx.outboxEvent.create({ data: adminOutbox(project.id, 'iam.project.created.v1', 'project', project.id, { projectId: project.id, code: project.code, name: project.name, actorUserId: input.actorUserId }, occurredAt) });
      await tx.auditEvent.create({ data: { projectId: project.id, actorUserId: input.actorUserId, action: 'PROJECT_CREATED', resourceType: 'project', resourceId: project.id, correlationId: input.correlationId, metadata: { code: project.code, name: project.name } } });
      return { id: project.id, code: project.code, name: project.name, status: project.status };
    });
  }

  async createBuilding(input: { projectId: string; code: string; name: string; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project || project.status !== 'ACTIVE') throw new Error('Project is not active');
      const building = await tx.building.create({ data: { projectId: input.projectId, code: input.code.trim(), name: input.name.trim() } });
      const occurredAt = new Date();
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.building.created.v1', 'building', building.id, { buildingId: building.id, projectId: input.projectId, code: building.code, actorUserId: input.actorUserId }, occurredAt) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'BUILDING_CREATED', resourceType: 'building', resourceId: building.id, correlationId: input.correlationId, metadata: { code: building.code, name: building.name } } });
      return { id: building.id, projectId: building.projectId, code: building.code, name: building.name, status: building.status };
    });
  }

  async createDepartment(input: { projectId: string; code: string; name: string; description?: string; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project || project.status !== 'ACTIVE') throw new Error('Project is not active');
      const department = await tx.department.create({ data: { projectId: input.projectId, code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() } });
      const occurredAt = new Date();
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.department.created.v1', 'department', department.id, { departmentId: department.id, projectId: input.projectId, code: department.code, actorUserId: input.actorUserId }, occurredAt) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'DEPARTMENT_CREATED', resourceType: 'department', resourceId: department.id, correlationId: input.correlationId, metadata: { code: department.code, name: department.name } } });
      return { id: department.id, projectId: department.projectId, code: department.code, name: department.name, isActive: department.isActive };
    });
  }

  async provisionUser(input: { projectId: string; emailNormalized: string; displayName: string; userType: 'BQL' | 'RESIDENT'; passwordHash: string; apartmentId?: string; buildingIds: string[]; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project || project.status !== 'ACTIVE') throw new Error('Project is not active');
      const buildings = input.buildingIds.length === 0 ? [] : await tx.building.findMany({ where: { projectId: input.projectId, id: { in: input.buildingIds }, status: 'ACTIVE' }, select: { id: true } });
      if (buildings.length !== input.buildingIds.length) throw new Error('One or more buildings are outside the project scope');
      const user = await tx.user.create({ data: { emailNormalized: input.emailNormalized, displayName: input.displayName, userType: input.userType, status: 'ACTIVE', passwordHash: input.passwordHash } });
      const membership = await tx.projectMembership.create({ data: { projectId: input.projectId, userId: user.id, status: 'ACTIVE', apartmentId: input.apartmentId, scopes: { create: input.buildingIds.map((buildingId) => ({ buildingId, apartmentId: input.apartmentId, scopeKey: input.apartmentId ? `BUILDING:${buildingId}:APARTMENT:${input.apartmentId}` : `BUILDING:${buildingId}` })) } } });
      const occurredAt = new Date();
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.user.provisioned.v1', 'user', user.id, { userId: user.id, membershipId: membership.id, projectId: input.projectId, userType: input.userType, actorUserId: input.actorUserId }, occurredAt) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'USER_PROVISIONED', resourceType: 'user', resourceId: user.id, correlationId: input.correlationId, metadata: { userType: input.userType, membershipId: membership.id } } });
      return { userId: user.id, membershipId: membership.id, projectId: input.projectId, emailNormalized: user.emailNormalized, status: user.status };
    });
  }

  async assignRole(input: { projectId: string; userId: string; roleCode: string; buildingIds: string[]; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const membership = await tx.projectMembership.findUnique({ where: { projectId_userId: { projectId: input.projectId, userId: input.userId } } });
      const role = await tx.role.findUnique({ where: { projectId_code: { projectId: input.projectId, code: input.roleCode } } });
      if (!membership || membership.status !== 'ACTIVE' || !role || !role.isActive) throw new Error('User membership or role is unavailable');
      const buildings = input.buildingIds.length === 0 ? [] : await tx.building.findMany({ where: { projectId: input.projectId, id: { in: input.buildingIds }, status: 'ACTIVE' }, select: { id: true } });
      if (buildings.length !== input.buildingIds.length) throw new Error('Role scope contains a building outside the project');
      const assignment = await tx.roleAssignment.create({ data: { projectId: input.projectId, userId: input.userId, roleId: role.id, source: 'DIRECT', scopes: { create: input.buildingIds.map((buildingId) => ({ scopeType: 'BUILDING', buildingId, scopeKey: `BUILDING:${buildingId}` })) } } });
      const updated = await tx.projectMembership.update({ where: { id: membership.id }, data: { version: { increment: 1 } }, select: { version: true } });
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.role.assigned.v1', 'role_assignment', assignment.id, { assignmentId: assignment.id, projectId: input.projectId, userId: input.userId, roleCode: input.roleCode, buildingIds: input.buildingIds, actorUserId: input.actorUserId, authorizationVersion: String(updated.version) }, new Date()) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'ROLE_ASSIGNED', resourceType: 'user', resourceId: input.userId, correlationId: input.correlationId, metadata: { roleCode: input.roleCode, buildingIds: input.buildingIds } } });
      return { userId: input.userId, projectId: input.projectId, authorizationVersion: String(updated.version) };
    });
  }

  async addDepartmentMember(input: { projectId: string; departmentCode: string; userId: string; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const department = await tx.department.findUnique({ where: { projectId_code: { projectId: input.projectId, code: input.departmentCode } } });
      const membership = await tx.projectMembership.findUnique({ where: { projectId_userId: { projectId: input.projectId, userId: input.userId } } });
      if (!department?.isActive || !membership || membership.status !== 'ACTIVE') throw new Error('Department or user membership is unavailable');
      await tx.departmentMember.upsert({ where: { departmentId_userId: { departmentId: department.id, userId: input.userId } }, create: { departmentId: department.id, userId: input.userId }, update: { removedAt: null } });
      const updated = await tx.projectMembership.update({ where: { id: membership.id }, data: { version: { increment: 1 } }, select: { version: true } });
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.department.member_added.v1', 'department_member', `${department.id}:${input.userId}`, { projectId: input.projectId, departmentId: department.id, userId: input.userId, actorUserId: input.actorUserId, authorizationVersion: String(updated.version) }, new Date()) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'DEPARTMENT_MEMBER_ADDED', resourceType: 'user', resourceId: input.userId, correlationId: input.correlationId, metadata: { departmentCode: input.departmentCode } } });
      return { userId: input.userId, projectId: input.projectId, authorizationVersion: String(updated.version) };
    });
  }

  async bindDepartmentRole(input: { projectId: string; departmentCode: string; roleCode: string; actorUserId: string; correlationId: string }) {
    return this.withSerializableRetry(async (tx) => {
      const department = await tx.department.findUnique({ where: { projectId_code: { projectId: input.projectId, code: input.departmentCode }, }, include: { members: { where: { removedAt: null }, select: { userId: true } } } });
      const role = await tx.role.findUnique({ where: { projectId_code: { projectId: input.projectId, code: input.roleCode } } });
      if (!department?.isActive || !role?.isActive) throw new Error('Department or role is unavailable');
      await tx.departmentRoleBinding.upsert({ where: { departmentId_roleId: { departmentId: department.id, roleId: role.id } }, create: { departmentId: department.id, roleId: role.id }, update: {} });
      const authorizationVersions: Array<{ userId: string; version: string }> = [];
      for (const member of department.members) {
        const updated = await tx.projectMembership.update({ where: { projectId_userId: { projectId: input.projectId, userId: member.userId } }, data: { version: { increment: 1 } }, select: { version: true } });
        authorizationVersions.push({ userId: member.userId, version: String(updated.version) });
      }
      await tx.outboxEvent.create({ data: adminOutbox(input.projectId, 'iam.department.role_bound.v1', 'department', department.id, { projectId: input.projectId, departmentCode: input.departmentCode, roleCode: input.roleCode, authorizationVersions, actorUserId: input.actorUserId }, new Date()) });
      await tx.auditEvent.create({ data: { projectId: input.projectId, actorUserId: input.actorUserId, action: 'DEPARTMENT_ROLE_BOUND', resourceType: 'department', resourceId: department.id, correlationId: input.correlationId, metadata: { roleCode: input.roleCode, authorizationVersions } } });
      return { authorizationVersions, projectId: input.projectId };
    });
  }

  private async revokeFamily(tx: TransactionClient, familyId: string, now: Date): Promise<void> {
    await tx.refreshTokenFamily.update({ where: { id: familyId }, data: { revokedAt: now } });
    const family = await tx.refreshTokenFamily.findUnique({ where: { id: familyId }, select: { sessionId: true } });
    if (family) await tx.authSession.update({ where: { id: family.sessionId }, data: { status: 'REVOKED', revokedAt: now } });
    await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }

  private async withSerializableRetry<T>(operation: (tx: TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2034' || attempt === 2) throw error;
      }
    }
    throw new Error('Serializable transaction retry budget exhausted');
  }
}
