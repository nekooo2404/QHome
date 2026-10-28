import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMagicBytes, normalizeSha256 } from './file-validation';

describe('document file validation', () => {
  it('accepts a PDF signature and rejects a mismatched MIME type', () => {
    assert.doesNotThrow(() => assertMagicBytes('application/pdf', Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])));
    assert.throws(() => assertMagicBytes('image/png', Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), /magic bytes/);
  });

  it('requires a canonical SHA-256 value', () => {
    assert.equal(normalizeSha256('A'.repeat(64)), 'a'.repeat(64));
    assert.throws(() => normalizeSha256('not-a-checksum'), /SHA-256/);
  });
});
