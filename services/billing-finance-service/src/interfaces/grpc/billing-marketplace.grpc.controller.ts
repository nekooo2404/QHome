import { Controller } from '@nestjs/common';
import { Ctx, GrpcMethod } from '@nestjs/microservices';
import { getGrpcRequestContext, GrpcCall } from '../../../../../libs/common/src/base-microservice';
import { MarketplacePaymentService } from '../../application/marketplace-payment.service';

type PaymentIntentRequest = { projectId: string; apartmentId: string; residentId: string; orderId: string; amountMinorUnits: string; currencyCode: string; idempotencyKey: string };
type RefundRequest = { projectId: string; apartmentId: string; residentId: string; orderId: string; paymentIntentId: string; amountMinorUnits: string; currencyCode: string; idempotencyKey: string; reason: string };

@Controller()
export class BillingMarketplaceGrpcController {
  constructor(private readonly payments: MarketplacePaymentService) {}

  @GrpcMethod('BillingFinanceService', 'CreateMarketplacePaymentIntent')
  createPaymentIntent(request: PaymentIntentRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    if (request.projectId !== context.tenantId || request.apartmentId !== context.apartmentId) throw new Error('request context does not match payment intent');
    return this.payments.createIntent({ ...request });
  }

  @GrpcMethod('BillingFinanceService', 'RequestMarketplaceRefund')
  requestRefund(request: RefundRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    if (request.projectId !== context.tenantId || request.apartmentId !== context.apartmentId) throw new Error('request context does not match refund');
    return this.payments.requestRefund({ ...request });
  }
}
