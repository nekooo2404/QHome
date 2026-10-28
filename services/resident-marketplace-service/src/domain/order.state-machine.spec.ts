import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidOrderTransitionError, transitionOrder } from './order.state-machine';

describe('resident marketplace order state machine', () => {
  it('allows the payment and fulfillment path', () => {
    const payment = transitionOrder({ current: 'CREATED', next: 'PAYMENT_PENDING', actorId: 'resident-1' });
    const paid = transitionOrder({ current: payment.to, next: 'PAID', actorId: 'billing-service' });
    const assigned = transitionOrder({ current: paid.to, next: 'PARTNER_ASSIGNED', actorId: 'marketplace-service' });
    assert.equal(assigned.to, 'PARTNER_ASSIGNED');
  });

  it('rejects skipping payment or assignment', () => {
    assert.throws(
      () => transitionOrder({ current: 'CREATED', next: 'IN_PROGRESS', actorId: 'resident-1' }),
      (error: unknown) => error instanceof InvalidOrderTransitionError,
    );
  });

  it('requires a reason for cancellation and refund', () => {
    assert.throws(() => transitionOrder({ current: 'PAID', next: 'CANCELLED', actorId: 'resident-1' }), /reason is required/);
    assert.throws(() => transitionOrder({ current: 'CANCELLED', next: 'REFUNDED', actorId: 'billing-service' }), /reason is required/);
  });

  it('does not reopen terminal orders', () => {
    assert.throws(() => transitionOrder({ current: 'REFUNDED', next: 'PAID', actorId: 'marketplace-service' }), InvalidOrderTransitionError);
  });
});
