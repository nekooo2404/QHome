export type ServiceOrderStatus =
  | 'CREATED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'PARTNER_ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface OrderTransition {
  from: ServiceOrderStatus;
  to: ServiceOrderStatus;
  actorId: string;
  occurredAt: Date;
  reason?: string;
}

export class InvalidOrderTransitionError extends Error {
  readonly code = 'INVALID_ORDER_TRANSITION';

  constructor(readonly from: ServiceOrderStatus, readonly to: ServiceOrderStatus) {
    super(`Invalid service-order transition ${from} -> ${to}`);
  }
}

const transitions: Record<ServiceOrderStatus, readonly ServiceOrderStatus[]> = {
  CREATED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED'],
  PAID: ['PARTNER_ASSIGNED', 'CANCELLED'],
  PARTNER_ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['REFUNDED'],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

export function assertOrderTransition(current: ServiceOrderStatus, next: ServiceOrderStatus): void {
  if (!transitions[current]?.includes(next)) {
    throw new InvalidOrderTransitionError(current, next);
  }
}

export function transitionOrder(input: {
  current: ServiceOrderStatus;
  next: ServiceOrderStatus;
  actorId: string;
  occurredAt?: Date;
  reason?: string;
}): OrderTransition {
  if (!input.actorId?.trim()) {
    throw new Error('actorId is required for order transition');
  }
  assertOrderTransition(input.current, input.next);
  if (['CANCELLED', 'REFUNDED'].includes(input.next) && !input.reason?.trim()) {
    throw new Error(`reason is required for ${input.next}`);
  }
  return {
    from: input.current,
    to: input.next,
    actorId: input.actorId,
    occurredAt: input.occurredAt ?? new Date(),
    reason: input.reason?.trim(),
  };
}
