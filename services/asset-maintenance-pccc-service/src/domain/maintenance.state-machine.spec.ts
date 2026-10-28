import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transitionMaintenanceWorkOrder } from './maintenance.state-machine';

describe('maintenance state machine', () => {
  it('allows an assigned work order to start', () => {
    const result = transitionMaintenanceWorkOrder({ current: 'ASSIGNED', next: 'IN_PROGRESS', actorId: 'tech-1' });
    assert.equal(result.to, 'IN_PROGRESS');
  });

  it('requires a reason when blocking a work order', () => {
    assert.throws(() => transitionMaintenanceWorkOrder({ current: 'IN_PROGRESS', next: 'BLOCKED', actorId: 'tech-1' }), /reason is required/);
  });
});
