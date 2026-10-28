export type PermissionEffect = 'ALLOW' | 'DENY';
export type PermissionScope =
  | { type: 'PROJECT'; projectId: string }
  | { type: 'BUILDING'; projectId: string; buildingId: string };

export interface PermissionGrant {
  permission: string;
  effect: PermissionEffect;
  scope: PermissionScope;
  source: 'ROLE' | 'DEPARTMENT_ROLE' | 'USER_OVERRIDE';
}

export interface PermissionMatrix {
  version: string;
  staffScope: boolean;
  grants: PermissionGrant[];
  buildingIds: string[];
  apartmentIds: string[];
}

export interface AuthorizationRequest {
  userId: string;
  projectId: string;
  permission: string;
  buildingId?: string;
  apartmentId?: string;
  sessionId?: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason:
    | 'ALLOWED'
    | 'PROJECT_MISMATCH'
    | 'BUILDING_SCOPE_REQUIRED'
    | 'EXPLICIT_DENY'
    | 'NO_MATCHING_PERMISSION'
    | 'USER_NOT_IN_PROJECT'
    | 'SESSION_REVOKED';
  authorizationVersion: string;
}

function scopeCovers(scope: PermissionScope, request: AuthorizationRequest): boolean {
  if (scope.projectId !== request.projectId) {
    return false;
  }
  if (scope.type === 'PROJECT') {
    return !request.buildingId || scope.projectId === request.projectId;
  }
  return Boolean(request.buildingId && scope.buildingId === request.buildingId);
}

export function evaluatePermission(
  matrix: PermissionMatrix | null,
  request: AuthorizationRequest,
): AuthorizationDecision {
  if (!matrix) {
    return { allowed: false, reason: 'USER_NOT_IN_PROJECT', authorizationVersion: '0' };
  }
  if (request.projectId.length === 0 || request.permission.length === 0) {
    return { allowed: false, reason: 'PROJECT_MISMATCH', authorizationVersion: matrix.version };
  }

  const grants = matrix.grants.filter((grant) => grant.permission === request.permission);
  const applicable = grants.filter((grant) => scopeCovers(grant.scope, request));
  if (applicable.some((grant) => grant.effect === 'DENY')) {
    return { allowed: false, reason: 'EXPLICIT_DENY', authorizationVersion: matrix.version };
  }
  if (applicable.some((grant) => grant.effect === 'ALLOW')) {
    if (request.apartmentId) {
      const apartmentScope = matrix.apartmentIds.includes(request.apartmentId);
      const buildingScope = Boolean(request.buildingId && matrix.buildingIds.includes(request.buildingId) && applicable.some((grant) => grant.effect === 'ALLOW' && grant.scope.type === 'BUILDING' && grant.scope.buildingId === request.buildingId));
      const projectStaffScope = matrix.staffScope && applicable.some((grant) => grant.effect === 'ALLOW' && grant.scope.type === 'PROJECT' && grant.scope.projectId === request.projectId);
      if (!apartmentScope && !buildingScope && !projectStaffScope) return { allowed: false, reason: 'BUILDING_SCOPE_REQUIRED', authorizationVersion: matrix.version };
    }
    return { allowed: true, reason: 'ALLOWED', authorizationVersion: matrix.version };
  }
  if (request.buildingId && !matrix.buildingIds.includes(request.buildingId)) {
    return { allowed: false, reason: 'BUILDING_SCOPE_REQUIRED', authorizationVersion: matrix.version };
  }
  return { allowed: false, reason: 'NO_MATCHING_PERMISSION', authorizationVersion: matrix.version };
}

export function assertTenantContext(projectId: string, tenantId: string): void {
  if (!projectId || !tenantId || projectId !== tenantId) {
    throw new Error('Tenant context mismatch');
  }
}
