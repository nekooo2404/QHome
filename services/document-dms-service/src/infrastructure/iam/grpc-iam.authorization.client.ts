import { Inject, Injectable } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { lastValueFrom, Observable, timeout } from 'rxjs';
import { injectGrpcMetadata } from '../../../../../libs/common/src/base-microservice';
import { createContextProof } from '../../../../../libs/common/src/context-proof';
import { DocumentContext, IamAuthorizationClient } from '../../application/ports';
import { DOCUMENT_DMS_TOKENS } from '../../document-dms.tokens';

interface IamGrpcService {
  verifyPermission(request: Record<string, unknown>, metadata?: Metadata): Observable<{ allowed: boolean; reason: string; authorizationVersion: string }>;
}

function metadataFor(context: DocumentContext): Metadata {
  const metadata = new Metadata();
  const baseContext = { correlationId: context.correlationId, tenantId: context.projectId, buildingId: context.buildingId, apartmentId: context.apartmentId, actorId: 'document-dms-service', subject: context.userId, clientType: 'internal-service', rolesHeader: 'internal-service', sessionId: context.sessionId };
  const proof = createContextProof(process.env.QHOME_CONTEXT_HMAC_SECRET ?? '', baseContext);
  injectGrpcMetadata(metadata, {
    ...baseContext,
    contextTimestamp: proof.timestamp,
    contextProof: proof.proof,
  });
  return metadata;
}

@Injectable()
export class GrpcIamAuthorizationClient implements IamAuthorizationClient {
  private readonly service: IamGrpcService;

  constructor(@Inject(DOCUMENT_DMS_TOKENS.IamGrpcClient) client: ClientGrpc) {
    this.service = client.getService<IamGrpcService>('IamTenantService');
  }

  verifyPermission(input: { context: DocumentContext; permission: string; buildingId?: string; apartmentId?: string }) {
    return lastValueFrom(this.service.verifyPermission({
      context: { correlationId: input.context.correlationId, tenantId: input.context.projectId, buildingId: input.context.buildingId, apartmentId: input.context.apartmentId, actorId: 'document-dms-service', subject: input.context.userId, clientType: 'internal-service', rolesHeader: 'internal-service', contextTimestamp: String(Date.now()), sessionId: input.context.sessionId },
      userId: input.context.userId,
      projectId: input.context.projectId,
      permission: input.permission,
      buildingId: input.buildingId,
      apartmentId: input.apartmentId,
    }, metadataFor(input.context)).pipe(timeout(3000)));
  }
}
