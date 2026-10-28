export type MaintenanceWorkOrderStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED';

export interface MaintenanceTransition {
  from: MaintenanceWorkOrderStatus;
  to: MaintenanceWorkOrderStatus;
  actorId: string;
  occurredAt: Date;
  reason?: string;
}

const transitions: Record<MaintenanceWorkOrderStatus, readonly MaintenanceWorkOrderStatus[]> = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'COMPLETED', 'CANCELLED'],
  BLOCKED: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertMaintenanceTransition(current: MaintenanceWorkOrderStatus, next: MaintenanceWorkOrderStatus): void {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid maintenance work-order transition ${current} -> ${next}`);
  }
}

export function transitionMaintenanceWorkOrder(input: {
  current: MaintenanceWorkOrderStatus;
  next: MaintenanceWorkOrderStatus;
  actorId: string;
  occurredAt?: Date;
  reason?: string;
}): MaintenanceTransition {
  if (!input.actorId) throw new Error('actorId is required for state transition');
  assertMaintenanceTransition(input.current, input.next);
  if (['BLOCKED', 'CANCELLED'].includes(input.next) && !input.reason?.trim()) throw new Error(`reason is required for ${input.next}`);
  return { from: input.current, to: input.next, actorId: input.actorId, occurredAt: input.occurredAt ?? new Date(), reason: input.reason };
}
