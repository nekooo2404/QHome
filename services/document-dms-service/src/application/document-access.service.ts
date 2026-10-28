import type { DocumentPermission, DocumentScopeType } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { DocumentAccessCache, DocumentContext, DocumentRepository, DocumentSnapshot, IamAuthorizationClient } from './ports';

function policyMatches(policy: { principalType: string; principalId?: string; permission: DocumentPermission; effect: string; buildingId?: string; apartmentId?: string }, context: DocumentContext, permission: DocumentPermission): boolean {
  if (policy.permission !== permission) return false;
  if (policy.principalType === 'USER' && policy.principalId !== context.userId) return false;
  if (policy.principalType === 'RESIDENT') {
    const targetApartment = policy.principalId ?? policy.apartmentId;
    if (targetApartment !== context.apartmentId) return false;
  }
  if (policy.principalType === 'ROLE' && (!policy.principalId || !context.roles.includes(policy.principalId))) return false;
  if (policy.buildingId && policy.buildingId !== context.buildingId) return false;
  if (policy.apartmentId && policy.apartmentId !== context.apartmentId) return false;
  return true;
}

export class DocumentAccessService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly iam: IamAuthorizationClient,
    private readonly cache: DocumentAccessCache,
  ) {}

  async assertDocumentAccess(context: DocumentContext, document: DocumentSnapshot, permission: DocumentPermission): Promise<void> {
    if (!(await this.canAccess(context, document, permission))) throw new ForbiddenException('Document access denied');
  }

  async assertScopeAccess(context: DocumentContext, scopeType: DocumentScopeType, buildingId?: string, apartmentId?: string, permission: DocumentPermission = 'WRITE'): Promise<void> {
    if (scopeType === 'BUILDING' && (!buildingId || buildingId !== context.buildingId)) throw new ForbiddenException('Building scope does not match request context');
    if (scopeType === 'RESIDENT' && (!apartmentId || apartmentId !== context.apartmentId)) throw new ForbiddenException('Resident scope does not match request context');
    if (scopeType === 'PROJECT' && !context.projectId) throw new ForbiddenException('Project scope is required');
    const decision = await this.iam.verifyPermission({ context, permission: `document.${permission.toLowerCase()}`, buildingId: scopeType === 'BUILDING' || scopeType === 'RESIDENT' ? buildingId ?? context.buildingId : undefined, apartmentId: scopeType === 'RESIDENT' ? apartmentId : undefined });
    if (!decision.allowed) throw new ForbiddenException(`Document permission denied: ${decision.reason}`);
  }

  private async canAccess(context: DocumentContext, document: DocumentSnapshot, permission: DocumentPermission): Promise<boolean> {
    const deny = async (key: string): Promise<boolean> => { await this.cache.set(key, false, 30); return false; };
    const sortedRoles = context.roles.slice().sort().join(',');
    const key = `dms:access:${context.projectId}:${document.id}:${document.accessVersion}:${context.userId}:${sortedRoles}:${permission}:${context.buildingId ?? '-'}:${context.apartmentId ?? '-'}`;
    const cached = await this.cache.get(key);
    if (cached !== undefined) return cached;
    if (document.projectId && document.projectId !== context.projectId) return deny(key);
    if (document.scopeType === 'BUILDING' && document.buildingId !== context.buildingId) return deny(key);
    if (document.scopeType === 'RESIDENT' && document.apartmentId !== context.apartmentId) return deny(key);

    const policies = await this.repository.getPolicies(document.id, document.folderId);
    const matchingPolicies = policies.filter((policy) => policyMatches(policy, context, permission));
    if (matchingPolicies.some((policy) => policy.effect === 'DENY')) return deny(key);
    const staffRole = context.roles.some((role) => /(?:^|[.:_-])(ADMIN|MANAGER|BQL|BUILDING|PROJECT|STAFF)(?:$|[.:_-])/iu.test(role));
    const residentRole = !staffRole;
    const explicitAllow = matchingPolicies.some((policy) => policy.effect === 'ALLOW');
    if (residentRole && document.scopeType !== 'RESIDENT' && !explicitAllow) return deny(key);
    const decision = await this.iam.verifyPermission({ context, permission: `document.${permission.toLowerCase()}`, buildingId: document.scopeType === 'BUILDING' || document.scopeType === 'RESIDENT' ? document.buildingId : undefined, apartmentId: document.scopeType === 'RESIDENT' ? document.apartmentId : undefined });
    const allowed = decision.allowed && (policies.length === 0 || explicitAllow);
    await this.cache.set(key, allowed, 30);
    return allowed;
  }
}
