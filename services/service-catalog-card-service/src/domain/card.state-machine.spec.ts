import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCardTransition } from './card.state-machine';

describe('smart card state machine', () => {
  it('does not resurrect a revoked card', () => {
    assert.throws(() => assertCardTransition('REVOKED', 'BLOCKED'), /Invalid card transition/);
    assert.throws(() => assertCardTransition('REVOKED', 'ACTIVE'), /Invalid card transition/);
  });

  it('allows only active-to-blocked and blocked-to-active recovery', () => {
    assert.doesNotThrow(() => assertCardTransition('ACTIVE', 'BLOCKED'));
    assert.doesNotThrow(() => assertCardTransition('BLOCKED', 'ACTIVE'));
  });
});
