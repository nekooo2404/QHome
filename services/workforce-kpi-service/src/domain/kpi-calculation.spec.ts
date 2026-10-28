import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateKpiScore } from './kpi-calculation';

describe('workforce KPI calculation', () => {
  it('weights difficulty and rating while preserving on-time completion', () => {
    const result = calculateKpiScore({ difficultyWeight: 2, startedAt: new Date('2026-01-01T08:00:00Z'), deadlineAt: new Date('2026-01-01T17:00:00Z'), completedAt: new Date('2026-01-01T16:00:00Z'), rating: 5 });
    assert.equal(result.onTime, true);
    assert.equal(result.completionMinutes, 480);
    assert.equal(result.score, 200);
  });
  it('reduces score for late completion', () => {
    const result = calculateKpiScore({ difficultyWeight: 1, startedAt: new Date('2026-01-01T08:00:00Z'), deadlineAt: new Date('2026-01-01T17:00:00Z'), completedAt: new Date('2026-01-02T17:00:00Z'), rating: 5 });
    assert.equal(result.onTime, false);
    assert.equal(result.score, 40);
  });
});
