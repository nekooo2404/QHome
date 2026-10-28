import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { positiveMinorUnits } from '../../domain/positive-minor-units';

describe('marketplace payment amount validation', () => {
  it('rejects negative minor units before the transaction', () => {
    assert.throws(() => positiveMinorUnits('-500000'), /strictly positive/);
    assert.throws(() => positiveMinorUnits('0'), /strictly positive/);
    assert.equal(positiveMinorUnits('500000'), 500000n);
  });
});
