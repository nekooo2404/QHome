import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePlate, assertProjectScope } from './models';

describe('property-resident domain invariants', () => {
  it('normalizes valid vehicle plates without accepting punctuation injection', () => {
    assert.equal(normalizePlate('  51A-123.45  '), '51A12345');
  });

  it('rejects a cross-project operation', () => {
    assert.throws(() => assertProjectScope('project-a', 'project-b'), { name: 'PropertyResidentValidationError' });
  });
});
