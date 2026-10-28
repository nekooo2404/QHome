import { Controller } from '@nestjs/common';
import { Ctx, GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { AuthorizationService } from '../../application/authorization.service';
import { getGrpcRequestContext, GrpcCall } from '../../../../../libs/common/src/base-microservice';

interface VerifyPermissionRequest {
  context?: { tenantId?: string; apartmentId?: string };
  userId?: string;
  projectId?: string;
  permission?: string;
  buildingId?: string;
  resourceType?: string;
  resourceId?: string;
  apartmentId?: string;
}

interface GetTenantContextRequest {
  context?: { tenantId?: string; apartmentId?: string };
  userId?: string;
  projectId?: string;
}

@Controller()
export class IamTenantGrpcController {
  constructor(private readonly authorization: AuthorizationService) {}

  @GrpcMethod('IamTenantService', 'VerifyPermission')
  async verifyPermission(request: VerifyPermissionRequest, @Ctx() call: GrpcCall) {
    const transportContext = getGrpcRequestContext(call);
    const userId = this.required(request.userId, 'user_id');
    const projectId = this.required(request.projectId, 'project_id');
    const permission = this.required(request.permission, 'permission');
    this.assertTargetPrincipal(transportContext.actorId, transportContext.clientType, userId);
    const apartmentId = request.apartmentId || request.context?.apartmentId || transportContext.apartmentId;
    if (transportContext.apartmentId && apartmentId && transportContext.apartmentId !== apartmentId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'apartment context mismatch' });
    }
    const decision = await this.authorization.verifyPermission({
      userId,
      projectId,
      permission,
      buildingId: request.buildingId,
      apartmentId,
      sessionId: transportContext.sessionId,
    }, transportContext.tenantId);
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      authorizationVersion: decision.authorizationVersion,
    };
  }

  @GrpcMethod('IamTenantService', 'GetTenantContext')
  async getTenantContext(request: GetTenantContextRequest, @Ctx() call: GrpcCall) {
    const transportContext = getGrpcRequestContext(call);
    const userId = this.required(request.userId, 'user_id');
    const projectId = this.required(request.projectId, 'project_id');
    this.assertTargetPrincipal(transportContext.actorId, transportContext.clientType, userId);
    const matrix = await this.authorization.getTenantContext(userId, projectId, transportContext.tenantId, transportContext.sessionId);
    return {
      projectId,
      userId,
      buildingIds: matrix.buildingIds,
      apartmentIds: matrix.apartmentIds,
      permissionCodes: Array.from(new Set(matrix.grants.filter((grant) => grant.effect === 'ALLOW').map((grant) => grant.permission))),
      authorizationVersion: matrix.version,
    };
  }

  private required(value: string | undefined, name: string): string {
    if (!value || value.length > 128) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is required` });
    }
    return value;
  }

  private assertTargetPrincipal(actorId: string | undefined, clientType: string | undefined, targetUserId: string): void {
    if (!actorId || (actorId !== targetUserId && clientType !== 'internal-service')) {
      throw new RpcException({ code: status.PERMISSION_DENIED, message: 'target principal is not authorized' });
    }
  }
}
