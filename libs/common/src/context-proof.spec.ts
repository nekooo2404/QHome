import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContextProof, verifyRequestContextProof } from './context-proof';

describe('request context HMAC proof', () => {
  it('rejects a forged 32-character proof', () => {
    const context = { tenantId: 'tenant-a', apartmentId: 'apt-a', actorId: 'user-a', rolesHeader: 'RESIDENT', correlationId: 'c1', contextTimestamp: '1700000000000' };
    assert.throws(() => verifyRequestContextProof('s'.repeat(32), context, 'a'.repeat(32), 'http', 1700000000000), /invalid/);
  });

  it('rejects replay outside the five-minute window', () => {
    const base = { tenantId: 'tenant-a', apartmentId: 'apt-a', actorId: 'user-a', rolesHeader: 'RESIDENT', correlationId: 'c1' };
    const generated = createContextProof('s'.repeat(32), base, 1_700_000_000_000);
    assert.throws(() => verifyRequestContextProof('s'.repeat(32), { ...base, contextTimestamp: generated.timestamp }, generated.proof, 'http', 1_700_000_301_000), /expired/);
  });

  it('binds building and subject changes to the signature', () => {
    const base = { tenantId: 'tenant-a', buildingId: 'building-a', apartmentId: 'apt-a', actorId: 'user-a', subject: 'user-a', sessionId: 'session-a', rolesHeader: 'RESIDENT', correlationId: 'c1' };
    const generated = createContextProof('s'.repeat(32), base, 1_700_000_000_000);
    assert.throws(() => verifyRequestContextProof('s'.repeat(32), { ...base, buildingId: 'building-b', contextTimestamp: generated.timestamp }, generated.proof, 'http', 1_700_000_000_000), /invalid/);
    assert.throws(() => verifyRequestContextProof('s'.repeat(32), { ...base, subject: 'user-b', contextTimestamp: generated.timestamp }, generated.proof, 'http', 1_700_000_000_000), /invalid/);
  });
});
