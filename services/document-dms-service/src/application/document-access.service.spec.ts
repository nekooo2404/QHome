import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentAccessService } from './document-access.service';

describe('document access isolation', () => {
  it('denies a resident access to an internal company document without an explicit policy', async () => {
    const cache = { values: new Map<string, boolean>(), get(key: string) { return Promise.resolve(this.values.get(key)); }, set(key: string, value: boolean) { this.values.set(key, value); return Promise.resolve(); } };
    const repository = { getPolicies: async () => [] };
    const iam = { verifyPermission: async () => ({ allowed: true, reason: 'ALLOWED', authorizationVersion: '1' }) };
    const service = new DocumentAccessService(repository as never, iam as never, cache as never);
    const document = { id: 'doc-1', projectId: 'project-a', scopeType: 'COMPANY', title: 'Internal', originalFileName: 'internal.pdf', status: 'AVAILABLE', currentVersionNumber: 1, accessVersion: 1, createdBy: 'staff', versions: [] } as never;
    await assert.rejects(() => service.assertDocumentAccess({ userId: 'resident-a', projectId: 'project-a', roles: [], correlationId: 'c1' }, document, 'DOWNLOAD'), /denied/);
    assert.equal(cache.values.size, 1);
    assert.equal(Array.from(cache.values.values())[0], false);
  });
});
