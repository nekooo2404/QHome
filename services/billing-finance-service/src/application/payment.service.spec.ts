import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './ports';

class FakeIdempotency {
  aborted = 0;
  private readonly completed = new Map<string, unknown>();
  async begin(_scope: string, key: string, _hash: string) { const body = this.completed.get(key); return body ? { acquired: false, cachedResponse: { statusCode: 200, body } } : { acquired: true }; }
  async complete(_scope: string, key: string, _hash: string, _statusCode: number, body: unknown) { this.completed.set(key, body); }
  async abort() { this.aborted += 1; }
}

class FakePaymentRepository implements Pick<PaymentRepository, 'applyPayment'> {
  calls = 0;
  async applyPayment(input: Parameters<PaymentRepository['applyPayment']>[0]) {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { paymentId: `${this.calls}`, appliedAmount: new Decimal(input.grossAmount), surplusAmount: new Decimal(0), invoiceIds: [] };
  }
}

function command(idempotencyKey: string) {
  return { projectId: '00000000-0000-0000-0000-000000000001', apartmentId: '00000000-0000-0000-0000-000000000002', provider: 'BANK', providerTransactionId: `txn-${idempotencyKey}`, idempotencyKey, channel: 'BANK_TRANSFER' as const, currencyCode: 'VND', grossAmount: '100' };
}

describe('payment service regression behavior', () => {
  it('allows concurrent webhook commands to reach the repository transaction boundary', async () => {
    const repository = new FakePaymentRepository();
    const idempotency = new FakeIdempotency();
    const service = new PaymentService(repository as PaymentRepository, {} as never, idempotency as never);
    const results = await Promise.all([service.applyPayment(command('k1')), service.applyPayment(command('k2'))]);
    assert.equal(results.length, 2);
    assert.equal(repository.calls, 2);
  });

  it('releases idempotency after a transient repository failure', async () => {
    const idempotency = new FakeIdempotency();
    const repository = { applyPayment: async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } };
    const service = new PaymentService(repository as PaymentRepository, {} as never, idempotency as never);
    await assert.rejects(() => service.applyPayment(command('retryable')), /deadlock detected/);
    assert.equal(idempotency.aborted, 1);
  });
});
