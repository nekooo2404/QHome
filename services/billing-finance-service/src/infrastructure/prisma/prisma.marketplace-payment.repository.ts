import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { MarketplacePaymentRepository } from '../../application/marketplace-payment.service';
import { positiveMinorUnits } from '../../domain/positive-minor-units';
import { ConflictException } from '@nestjs/common';

export class PrismaMarketplacePaymentRepository implements MarketplacePaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createIntent(input: Parameters<MarketplacePaymentRepository['createIntent']>[0]) {
    const amountMinorUnits = positiveMinorUnits(input.amountMinorUnits);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.marketplacePaymentIntent.findFirst({ where: { projectId: input.projectId, OR: [{ orderId: input.orderId }, { idempotencyKey: input.idempotencyKey }] } });
      if (existing) {
        if (existing.orderId !== input.orderId || existing.apartmentId !== input.apartmentId || String(existing.amountMinorUnits) !== input.amountMinorUnits || existing.currencyCode !== input.currencyCode) throw new Error('payment intent conflicts with the order');
        return { paymentIntentId: existing.id, status: existing.status, provider: existing.provider };
      }
      const provider = process.env.BILLING_MARKETPLACE_PAYMENT_PROVIDER ?? 'QHOME_CHECKOUT';
      const intent = await tx.marketplacePaymentIntent.create({ data: { projectId: input.projectId, apartmentId: input.apartmentId, residentId: input.residentId, orderId: input.orderId, provider, status: 'REQUIRES_PAYMENT', currencyCode: input.currencyCode, amountMinorUnits, idempotencyKey: input.idempotencyKey } });
      await tx.outboxEvent.create({ data: { eventId: randomUUID(), projectId: input.projectId, topic: 'qhome.billing.events.v1', eventType: 'billing.payment_intent.created.v1', aggregateType: 'marketplace_payment_intent', aggregateId: intent.id, payload: { paymentIntentId: intent.id, orderId: input.orderId, projectId: input.projectId, amountMinorUnits: input.amountMinorUnits, currencyCode: input.currencyCode, status: intent.status }, headers: {} } });
      return { paymentIntentId: intent.id, status: intent.status, provider: intent.provider };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async requestRefund(input: Parameters<MarketplacePaymentRepository['requestRefund']>[0]) {
    const amountMinorUnits = positiveMinorUnits(input.amountMinorUnits);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.marketplaceRefund.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } } });
      if (existing) {
        if (existing.paymentIntentId !== input.paymentIntentId || existing.orderId !== input.orderId || existing.apartmentId !== input.apartmentId || existing.currencyCode !== input.currencyCode || existing.amountMinorUnits !== amountMinorUnits) throw new ConflictException('Refund idempotency key conflicts with the original request');
        return { refundId: existing.id, status: existing.status };
      }
      const intents = await tx.$queryRawUnsafe<Array<{ id: string; status: string; project_id: string; order_id: string; apartment_id: string; currency_code: string; amount_minor_units: bigint }>>('SELECT id, status::text AS status, project_id, order_id, apartment_id, currency_code, amount_minor_units FROM marketplace_payment_intents WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.paymentIntentId, input.projectId);
      const intent = intents[0];
      if (!intent || intent.order_id !== input.orderId || intent.apartment_id !== input.apartmentId || intent.currency_code !== input.currencyCode) throw new ConflictException('Payment intent does not match the refund request');
      if (intent.status !== 'SUCCEEDED') throw new ConflictException('Only succeeded payment intents can be refunded');
      if (amountMinorUnits > intent.amount_minor_units) throw new ConflictException('Refund amount exceeds the captured payment amount');
      const existingForIntent = await tx.marketplaceRefund.findUnique({ where: { paymentIntentId: input.paymentIntentId } });
      if (existingForIntent) throw new ConflictException('Payment intent already has a refund');
      let refund;
      try { refund = await tx.marketplaceRefund.create({ data: { projectId: input.projectId, paymentIntentId: intent.id, orderId: input.orderId, apartmentId: input.apartmentId, amountMinorUnits, currencyCode: input.currencyCode, status: 'PENDING', idempotencyKey: input.idempotencyKey, reason: input.reason } }); }
      catch (error: unknown) { if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Payment intent already has a refund'); throw error; }
      await tx.outboxEvent.create({ data: { eventId: randomUUID(), projectId: input.projectId, topic: 'qhome.billing.events.v1', eventType: 'billing.refund.requested.v1', aggregateType: 'marketplace_refund', aggregateId: refund.id, payload: { refundId: refund.id, paymentIntentId: intent.id, orderId: input.orderId, projectId: input.projectId, apartmentId: input.apartmentId, amountMinorUnits: input.amountMinorUnits, currencyCode: input.currencyCode, status: refund.status, reason: input.reason }, headers: {} } });
      return { refundId: refund.id, status: refund.status };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }
}
