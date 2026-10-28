import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isApartmentScopeAllowed } from './context-proof';

describe('apartment scope guard', () => {
  it('rejects a resident from another apartment', () => {
    assert.equal(isApartmentScopeAllowed({ tenantId: 'p1', correlationId: 'c1', apartmentId: 'a1' }, 'a2'), false);
  });

  it('allows an explicitly building-scoped administrator', () => {
    assert.equal(isApartmentScopeAllowed({ tenantId: 'p1', correlationId: 'c1', rolesHeader: 'BUILDING_ADMIN' }, 'a2'), true);
  });
});
