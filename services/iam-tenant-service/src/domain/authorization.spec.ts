import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePermission, PermissionMatrix } from './authorization';

const matrix: PermissionMatrix = {
  version: '4',
  staffScope: false,
  grants: [
    { permission: 'building.read', effect: 'ALLOW', source: 'ROLE', scope: { type: 'BUILDING', projectId: 'p1', buildingId: 'b1' } },
    { permission: 'building.read', effect: 'DENY', source: 'USER_OVERRIDE', scope: { type: 'BUILDING', projectId: 'p1', buildingId: 'b1' } },
    { permission: 'project.read', effect: 'ALLOW', source: 'ROLE', scope: { type: 'PROJECT', projectId: 'p1' } },
  ],
  buildingIds: ['b1'],
  apartmentIds: ['a1'],
};

describe('IAM authorization evaluation', () => {
  it('applies an explicit deny over a role allow', () => {
    const decision = evaluatePermission(matrix, { userId: 'u1', projectId: 'p1', permission: 'building.read', buildingId: 'b1' });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'EXPLICIT_DENY');
  });

  it('rejects a building outside the membership scope', () => {
    const decision = evaluatePermission(matrix, { userId: 'u1', projectId: 'p1', permission: 'building.read', buildingId: 'b2' });
    assert.equal(decision.reason, 'BUILDING_SCOPE_REQUIRED');
  });

  it('allows a project-scoped permission only in the same project', () => {
    assert.equal(evaluatePermission(matrix, { userId: 'u1', projectId: 'p1', permission: 'project.read' }).allowed, true);
    assert.equal(evaluatePermission(matrix, { userId: 'u1', projectId: 'p2', permission: 'project.read' }).allowed, false);
  });

  it('denies apartment access when the apartment scope is empty', () => {
    const noApartmentScope = { ...matrix, apartmentIds: [], buildingIds: [] };
    assert.equal(evaluatePermission(noApartmentScope, { userId: 'u1', projectId: 'p1', permission: 'project.read', apartmentId: 'apt-b' }).allowed, false);
  });
});
