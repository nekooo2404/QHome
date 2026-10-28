import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBookingTransition, assertWorkflowTransition } from './booking';

describe('resident registration workflows', () => {
  it('keeps amenity holds inside the payment workflow', () => {
    assertBookingTransition('HELD', 'PENDING_PAYMENT');
    assert.throws(() => assertBookingTransition('HELD', 'COMPLETED'), /Invalid booking transition/);
  });

  it('requires an approver for approval decisions', () => {
    assert.throws(() => assertWorkflowTransition('UNDER_REVIEW', 'APPROVED'), /approverId is required/);
    assert.doesNotThrow(() => assertWorkflowTransition('UNDER_REVIEW', 'APPROVED', 'manager-1'));
  });
});
