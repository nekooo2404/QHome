import { HttpException, Logger } from '@nestjs/common';
import { BillingPaymentEvent, BillingFinanceClient, MarketplaceContext, MarketplaceRepository, OrderSnapshot } from './ports';

export class OrderSagaOrchestrator {
  private readonly logger = new Logger(OrderSagaOrchestrator.name);

  constructor(
    private readonly repository: MarketplaceRepository,
    private readonly billing: BillingFinanceClient,
  ) {}

  async startPayment(order: OrderSnapshot, context: MarketplaceContext): Promise<OrderSnapshot> {
    if (!['CREATED', 'PAYMENT_PENDING'].includes(order.status) || (order.status === 'PAYMENT_PENDING' && order.paymentIntentId)) return order;

    const pending = order.status === 'PAYMENT_PENDING' ? order : await this.repository.transitionOrder({
      projectId: context.projectId,
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus: 'PAYMENT_PENDING',
      actorId: context.actorId,
      correlationId: context.correlationId,
    });
    await this.repository.updateSaga({ projectId: context.projectId, orderId: order.id, status: 'PAYMENT_PENDING', currentStep: 'CREATE_PAYMENT_INTENT' });

    try {
      const payment = await this.billing.createPaymentIntent({
        projectId: context.projectId,
        buildingId: context.buildingId,
        apartmentId: context.apartmentId,
        residentId: context.residentId,
        orderId: order.id,
        amountMinorUnits: order.totalMinorUnits,
        currencyCode: order.currencyCode,
        idempotencyKey: `order-payment:${order.id}`,
        correlationId: context.correlationId,
      });
      let withIntent: OrderSnapshot;
      try {
        withIntent = await this.repository.setPaymentIntent({ projectId: context.projectId, orderId: order.id, paymentIntentId: payment.paymentIntentId, expectedVersion: pending.version });
      } catch (error: unknown) {
        const current = await this.repository.getOrder(context.projectId, context.apartmentId, order.id);
        if (!current || current.paymentIntentId !== payment.paymentIntentId) throw error;
        withIntent = current;
      }
      await this.repository.updateSaga({ projectId: context.projectId, orderId: order.id, status: 'PAYMENT_PENDING', currentStep: 'WAITING_FOR_PAYMENT', paymentIntentId: payment.paymentIntentId });
      return withIntent;
    } catch (error: unknown) {
      await this.repository.updateSaga({ projectId: context.projectId, orderId: order.id, status: 'FAILED', currentStep: 'CREATE_PAYMENT_INTENT', lastError: error instanceof Error ? error.message.slice(0, 2000) : 'payment intent creation failed' });
      await this.repository.transitionOrder({
        projectId: context.projectId,
        orderId: order.id,
        expectedVersion: pending.version,
        nextStatus: 'CANCELLED',
        actorId: context.actorId,
        reason: 'Unable to create payment intent',
        correlationId: context.correlationId,
      }).catch((cancelError: unknown) => this.logger.error('failed to cancel payment-pending order', cancelError instanceof Error ? cancelError.stack : String(cancelError)));
      throw new HttpException('payment intent is temporarily unavailable', 503);
    }
  }

  async handleBillingEvent(event: BillingPaymentEvent): Promise<OrderSnapshot | undefined> {
    const order = await this.repository.getOrder(event.projectId, '', event.orderId);
    if (!order) return undefined;

    if (event.eventType === 'billing.payment_intent.succeeded.v1') {
      return this.confirmPaymentAndDispatch(order, event);
    }
    if (event.eventType === 'billing.refund.completed.v1') {
      if (order.status === 'REFUNDED') return order;
      if (order.status !== 'CANCELLED' || !event.refundId || !order.paymentIntentId || event.paymentIntentId !== order.paymentIntentId) return undefined;
      return this.repository.transitionOrder({
        projectId: event.projectId,
        orderId: order.id,
        expectedVersion: order.version,
        nextStatus: 'REFUNDED',
        actorId: 'billing-finance-service',
        reason: 'Billing confirmed refund',
        correlationId: event.correlationId ?? event.eventId,
      });
    }
    return undefined;
  }

  async retryCompensation(order: OrderSnapshot): Promise<OrderSnapshot> {
    return this.refundIfRequired(order, {
      projectId: order.projectId,
      buildingId: order.addressSnapshot.buildingId as string,
      apartmentId: order.apartmentId,
      residentId: order.residentId,
      actorId: 'marketplace-saga-retry',
      correlationId: `refund-retry:${order.id}`,
    }, order.cancellationReason ?? 'Compensating refund retry');
  }

  private async confirmPaymentAndDispatch(order: OrderSnapshot, event: BillingPaymentEvent): Promise<OrderSnapshot> {
    if (order.status === 'REFUNDED') return order;
    if (order.status === 'CANCELLED') {
      let cancelled = order;
      if (!cancelled.paymentIntentId) {
        cancelled = await this.repository.setPaymentIntent({ projectId: order.projectId, orderId: order.id, paymentIntentId: event.paymentIntentId, expectedVersion: order.version });
      }
      if (cancelled.paymentIntentId === event.paymentIntentId) {
        return this.refundIfRequired(cancelled, {
          projectId: order.projectId,
          buildingId: order.addressSnapshot.buildingId as string,
          apartmentId: order.apartmentId,
          residentId: order.residentId,
          actorId: 'billing-finance-service',
          correlationId: event.correlationId ?? event.eventId,
        }, 'Payment completed after order cancellation');
      }
      return order;
    }
    if (!['PAYMENT_PENDING', 'PAID'].includes(order.status)) return order;
    let current = order;
    if (!current.paymentIntentId) {
      try {
        current = await this.repository.setPaymentIntent({ projectId: order.projectId, orderId: order.id, paymentIntentId: event.paymentIntentId, expectedVersion: order.version });
      } catch {
        current = await this.repository.getOrder(order.projectId, order.apartmentId, order.id) ?? order;
      }
    }
    if (current.paymentIntentId && current.paymentIntentId !== event.paymentIntentId) throw new HttpException('payment intent does not match order', 409);

    const paid = current.status === 'PAID'
      ? current
      : await this.repository.transitionOrder({
        projectId: current.projectId,
        orderId: current.id,
        expectedVersion: current.version,
        nextStatus: 'PAID',
        actorId: 'billing-finance-service',
        correlationId: event.correlationId ?? event.eventId,
      });
    await this.repository.updateSaga({ projectId: paid.projectId, orderId: paid.id, status: 'PAYMENT_CONFIRMED', currentStep: 'DISPATCH_ORDER', paymentIntentId: event.paymentIntentId });

    if (paid.type === 'INTERNAL_SHOP') {
      if (!paid.shopPartnerId) return this.cancelAndCompensate(paid, event.correlationId ?? event.eventId, 'Internal shop has no fulfillment partner');
      return this.repository.assignOrder({ projectId: paid.projectId, orderId: paid.id, expectedVersion: paid.version, actorId: 'marketplace-service', correlationId: event.correlationId ?? event.eventId, partnerId: paid.shopPartnerId });
    }

    if (!paid.requiresTechnician) {
      if (!paid.servicePartnerId) return this.cancelAndCompensate(paid, event.correlationId ?? event.eventId, 'Home service has no fulfillment partner');
      return this.repository.assignOrder({ projectId: paid.projectId, orderId: paid.id, expectedVersion: paid.version, actorId: 'marketplace-service', correlationId: event.correlationId ?? event.eventId, partnerId: paid.servicePartnerId });
    }

    const candidates = await this.repository.findTechnicianCandidates({
      projectId: paid.projectId,
      buildingId: paid.addressSnapshot.buildingId as string,
      skills: paid.requiredSkills,
      startsAt: paid.scheduledStart!,
      endsAt: paid.scheduledEnd!,
    });
    const candidate = candidates[0];
    if (!candidate) return this.cancelAndCompensate(paid, event.correlationId ?? event.eventId, 'No technician accepted the requested time slot');

    return this.repository.assignOrder({
      projectId: paid.projectId,
      orderId: paid.id,
      expectedVersion: paid.version,
      actorId: 'marketplace-service',
      correlationId: event.correlationId ?? event.eventId,
      partnerId: candidate.partnerId,
      technicianId: candidate.id,
      score: candidate.score,
    });
  }

  async cancelOrder(order: OrderSnapshot, context: MarketplaceContext, reason: string): Promise<OrderSnapshot> {
    if (order.status === 'REFUNDED') return order;
    if (order.status === 'CANCELLED') {
      return order.paymentIntentId ? this.refundIfRequired(order, context, reason) : order;
    }
    const cancelled = await this.repository.transitionOrder({
      projectId: context.projectId,
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus: 'CANCELLED',
      actorId: context.actorId,
      reason,
      correlationId: context.correlationId,
    });
    if (order.status === 'PAYMENT_PENDING' || !order.paymentIntentId) return cancelled;
    return this.refundIfRequired(cancelled, context, reason);
  }

  private cancelAndCompensate(order: OrderSnapshot, correlationId: string, reason: string): Promise<OrderSnapshot> {
    const context: MarketplaceContext = {
      projectId: order.projectId,
      buildingId: order.addressSnapshot.buildingId as string,
      apartmentId: order.apartmentId,
      residentId: order.residentId,
      actorId: 'marketplace-service',
      correlationId,
    };
    return this.cancelOrder(order, context, reason);
  }

  private async refundIfRequired(order: OrderSnapshot, context: MarketplaceContext, reason: string): Promise<OrderSnapshot> {
    if (order.status === 'REFUNDED') return order;
    if (!order.paymentIntentId) return order;
    await this.repository.updateSaga({ projectId: order.projectId, orderId: order.id, status: 'COMPENSATING', currentStep: 'REQUEST_REFUND', paymentIntentId: order.paymentIntentId, lastError: undefined });
    try {
      const refund = await this.billing.requestRefund({
        projectId: order.projectId,
        buildingId: context.buildingId,
        apartmentId: order.apartmentId,
        residentId: order.residentId,
        orderId: order.id,
        paymentIntentId: order.paymentIntentId,
        amountMinorUnits: order.totalMinorUnits,
        currencyCode: order.currencyCode,
        idempotencyKey: `order-refund:${order.id}`,
        correlationId: context.correlationId,
        reason,
      });
      await this.repository.updateSaga({ projectId: order.projectId, orderId: order.id, status: 'COMPENSATED', currentStep: 'REFUND_REQUESTED', paymentIntentId: order.paymentIntentId, refundId: refund.refundId });
      if (refund.status === 'REFUNDED' || refund.status === 'SUCCEEDED') {
        await this.repository.updateSaga({ projectId: order.projectId, orderId: order.id, status: 'COMPENSATED', currentStep: 'REFUND_COMPLETED', paymentIntentId: order.paymentIntentId, refundId: refund.refundId });
        return this.repository.transitionOrder({ projectId: order.projectId, orderId: order.id, expectedVersion: order.version, nextStatus: 'REFUNDED', actorId: 'billing-finance-service', reason: 'Compensating refund completed', correlationId: context.correlationId });
      }
      await this.repository.updateSaga({ projectId: order.projectId, orderId: order.id, status: 'COMPENSATING', currentStep: 'REFUND_REQUESTED', paymentIntentId: order.paymentIntentId, refundId: refund.refundId, nextAttemptAt: new Date(Date.now() + 60_000) });
      return order;
    } catch (error: unknown) {
      await this.repository.updateSaga({ projectId: order.projectId, orderId: order.id, status: 'FAILED', currentStep: 'REQUEST_REFUND', paymentIntentId: order.paymentIntentId, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'refund request failed', nextAttemptAt: new Date(Date.now() + 5000) });
      throw new HttpException('order cancelled; refund is pending retry', 503);
    }
  }
}
