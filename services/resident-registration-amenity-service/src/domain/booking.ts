export type BookingStatus = 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'COMPLETED';
export type WorkflowStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED';

export class LockExpiredError extends Error {
  readonly code = 'DISTRIBUTED_LOCK_EXPIRED';
  constructor() { super('Distributed booking lock no longer has enough validity'); }
}

export function assertBookingTransition(current: BookingStatus, next: BookingStatus): void {
  const allowed: Record<BookingStatus, BookingStatus[]> = {
    HELD: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
    PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
    CONFIRMED: ['COMPLETED', 'CANCELLED'],
    CANCELLED: [],
    EXPIRED: [],
    COMPLETED: [],
  };
  if (!allowed[current].includes(next)) throw new Error('Invalid booking transition ' + current + ' -> ' + next);
}

export function assertWorkflowTransition(current: WorkflowStatus, next: WorkflowStatus, approverId?: string): void {
  const allowed: Record<WorkflowStatus, WorkflowStatus[]> = {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['UNDER_REVIEW', 'REJECTED', 'CANCELLED'],
    UNDER_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['COMPLETED', 'CANCELLED'],
    REJECTED: ['DRAFT', 'CANCELLED'],
    CANCELLED: [],
    COMPLETED: [],
  };
  if (!allowed[current].includes(next)) throw new Error('Invalid workflow transition ' + current + ' -> ' + next);
  if (['APPROVED', 'REJECTED'].includes(next) && !approverId) throw new Error('approverId is required');
}
