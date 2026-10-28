export interface MarketplacePaymentRepository {
  createIntent(input: { projectId: string; apartmentId: string; residentId: string; orderId: string; amountMinorUnits: string; currencyCode: string; idempotencyKey: string }): Promise<{ paymentIntentId: string; status: string; provider: string }>;
  requestRefund(input: { projectId: string; apartmentId: string; residentId: string; orderId: string; paymentIntentId: string; amountMinorUnits: string; currencyCode: string; idempotencyKey: string; reason: string }): Promise<{ refundId: string; status: string }>;
}

export class MarketplacePaymentService {
  constructor(private readonly repository: MarketplacePaymentRepository) {}

  createIntent(input: Parameters<MarketplacePaymentRepository['createIntent']>[0]) {
    return this.repository.createIntent(input);
  }

  requestRefund(input: Parameters<MarketplacePaymentRepository['requestRefund']>[0]) {
    return this.repository.requestRefund(input);
  }
}
