import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecurityQrPassService } from './qr-pass';

describe('security QR pass', () => {
  it('signs and verifies a short-lived pass', () => {
    let now = 1_000;
    const service = new SecurityQrPassService('a'.repeat(32), () => now);
    const issued = service.issue({ projectId: 'p1', requestId: 'r1', residentId: 'u1', type: 'MOVING', ttlMs: 1_000 });
    assert.equal(service.verify(issued.token).requestId, 'r1');
    now = 2_000;
    assert.throws(() => service.verify(issued.token), /validity window/);
  });

  it('rejects a tampered signature', () => {
    const service = new SecurityQrPassService('a'.repeat(32));
    const issued = service.issue({ projectId: 'p1', requestId: 'r1', residentId: 'u1', type: 'REPAIR', ttlMs: 1_000 });
    const [encoded, signature] = issued.token.split('.');
    const tampered = `${encoded}.${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    assert.throws(() => service.verify(tampered), /signature/);
  });
});
