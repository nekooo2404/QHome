import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import { assertBalancedLedger, planPaymentApplication } from './finance.types';

describe('billing finance invariants', () => {
  it('allocates partial payment without creating surplus', () => {
    const result = planPaymentApplication(new Decimal('40'), [{ id: 'inv-1', projectId: 'p', apartmentId: 'a', currencyCode: 'VND', totalAmount: new Decimal('100'), paidAmount: new Decimal('0'), status: 'ISSUED' }]);
    assert.equal(result.allocations[0].amount.toFixed(), '40');
    assert.equal(result.surplus.toFixed(), '0');
  });

  it('allocates overpayment and preserves surplus wallet credit', () => {
    const result = planPaymentApplication(new Decimal('150'), [{ id: 'inv-1', projectId: 'p', apartmentId: 'a', currencyCode: 'VND', totalAmount: new Decimal('100'), paidAmount: new Decimal('0'), status: 'ISSUED' }]);
    assert.equal(result.appliedAmount.toFixed(), '100');
    assert.equal(result.surplus.toFixed(), '50');
  });

  it('rejects an unbalanced ledger', () => {
    assert.throws(() => assertBalancedLedger([{ accountCode: 'CASH', side: 'DEBIT', amount: new Decimal('10'), currencyCode: 'VND', description: 'cash' }]), /at least two/);
  });

  it('balances a wallet-only payment without a zero receivable line', () => {
    const lines = [
      { accountCode: 'BANK_CASH', side: 'DEBIT' as const, amount: new Decimal('150'), currencyCode: 'VND', description: 'cash' },
      { accountCode: 'APARTMENT_WALLET_LIABILITY', side: 'CREDIT' as const, amount: new Decimal('150'), currencyCode: 'VND', description: 'wallet surplus' },
    ];
    assert.doesNotThrow(() => assertBalancedLedger(lines));
  });
});
