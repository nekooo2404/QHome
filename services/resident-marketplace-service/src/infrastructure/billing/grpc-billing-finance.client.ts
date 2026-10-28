import { Inject, Injectable } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { lastValueFrom, Observable, timeout } from 'rxjs';
import { injectGrpcMetadata } from '../../../../../libs/common/src/base-microservice';
import { createContextProof } from '../../../../../libs/common/src/context-proof';
import { BillingFinanceClient } from '../../application/ports';
import { MARKETPLACE_TOKENS } from '../../marketplace.tokens';

interface BillingFinanceGrpcService {
  createMarketplacePaymentIntent(request: Record<string, unknown>, metadata?: Metadata): Observable<{ paymentIntentId: string; status: string; provider: string }>;
  requestMarketplaceRefund(request: Record<string, unknown>, metadata?: Metadata): Observable<{ refundId: string; status: string }>;
}

function metadataFor(input: { correlationId: string; projectId: string; buildingId: string; apartmentId: string }): Metadata {
  const metadata = new Metadata();
  const baseContext = { correlationId: input.correlationId, tenantId: input.projectId, buildingId: input.buildingId, apartmentId: input.apartmentId, actorId: 'resident-marketplace-service', clientType: 'internal-grpc', rolesHeader: 'internal-service' };
  const proof = createContextProof(process.env.QHOME_CONTEXT_HMAC_SECRET ?? '', baseContext);
  injectGrpcMetadata(metadata, {
    ...baseContext,
    contextTimestamp: proof.timestamp,
    contextProof: proof.proof,
  });
  return metadata;
}

@Injectable()
export class GrpcBillingFinanceClient implements BillingFinanceClient {
  private readonly service: BillingFinanceGrpcService;

  constructor(@Inject(MARKETPLACE_TOKENS.BillingGrpcClient) client: ClientGrpc) {
    this.service = client.getService<BillingFinanceGrpcService>('BillingFinanceService');
  }

  async createPaymentIntent(input: Parameters<BillingFinanceClient['createPaymentIntent']>[0]): Promise<{ paymentIntentId: string; status: string; provider: string }> {
    return lastValueFrom(this.service.createMarketplacePaymentIntent({
      context: { correlationId: input.correlationId, tenantId: input.projectId, buildingId: input.buildingId, apartmentId: input.apartmentId, actorId: 'resident-marketplace-service', rolesHeader: 'internal-service', contextTimestamp: String(Date.now()) },
      projectId: input.projectId,
      apartmentId: input.apartmentId,
      residentId: input.residentId,
      orderId: input.orderId,
      amountMinorUnits: input.amountMinorUnits,
      currencyCode: input.currencyCode,
      idempotencyKey: input.idempotencyKey,
    }, metadataFor(input)).pipe(timeout(5000)));
  }

  async requestRefund(input: Parameters<BillingFinanceClient['requestRefund']>[0]): Promise<{ refundId: string; status: string }> {
    return lastValueFrom(this.service.requestMarketplaceRefund({
      context: { correlationId: input.correlationId, tenantId: input.projectId, buildingId: input.buildingId, apartmentId: input.apartmentId, actorId: 'resident-marketplace-service', rolesHeader: 'internal-service', contextTimestamp: String(Date.now()) },
      projectId: input.projectId,
      apartmentId: input.apartmentId,
      residentId: input.residentId,
      orderId: input.orderId,
      paymentIntentId: input.paymentIntentId,
      amountMinorUnits: input.amountMinorUnits,
      currencyCode: input.currencyCode,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    }, metadataFor(input)).pipe(timeout(5000)));
  }
}
