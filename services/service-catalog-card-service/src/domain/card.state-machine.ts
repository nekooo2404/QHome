import { SmartCardRecord } from '../application/ports';

export function assertCardTransition(current: SmartCardRecord['status'], next: SmartCardRecord['status']): void {
  const allowed: Record<SmartCardRecord['status'], readonly SmartCardRecord['status'][]> = {
    PENDING: ['ACTIVE', 'REVOKED'],
    ACTIVE: ['BLOCKED', 'REVOKED', 'EXPIRED'],
    BLOCKED: ['ACTIVE', 'REVOKED', 'EXPIRED'],
    REVOKED: [],
    EXPIRED: ['REVOKED'],
  };
  if (!allowed[current].includes(next)) throw new Error(`Invalid card transition ${current} -> ${next}`);
}
