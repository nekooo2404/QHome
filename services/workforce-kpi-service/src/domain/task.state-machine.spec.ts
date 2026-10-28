import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTaskTransitionError, transitionTask } from './task.state-machine';

describe('workforce task state machine', () => {
  it('rejects skipping submission before completion', () => {
    assert.throws(() => transitionTask({ from: 'IN_PROGRESS', to: 'COMPLETED', actorId: 'manager-1' }), InvalidTaskTransitionError);
  });
  it('requires reason for overdue and supports rejection back to work', () => {
    assert.throws(() => transitionTask({ from: 'IN_PROGRESS', to: 'OVERDUE', actorId: 'system' }), /reason is required/);
    assert.equal(transitionTask({ from: 'SUBMITTED', to: 'REJECTED', actorId: 'manager-1', reason: 'Evidence is incomplete' }).to, 'REJECTED');
  });
});
