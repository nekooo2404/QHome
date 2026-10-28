export type TaskStatus = 'CREATED' | 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'COMPLETED' | 'REJECTED' | 'OVERDUE' | 'CANCELLED';

export class InvalidTaskTransitionError extends Error {
  readonly code = 'INVALID_TASK_TRANSITION';
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) { super(`Invalid task transition ${from} -> ${to}`); }
}

const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'IN_PROGRESS', 'OVERDUE', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'OVERDUE', 'CANCELLED'],
  IN_PROGRESS: ['SUBMITTED', 'OVERDUE', 'CANCELLED'],
  SUBMITTED: ['COMPLETED', 'REJECTED'],
  REJECTED: ['IN_PROGRESS', 'CANCELLED'],
  OVERDUE: ['IN_PROGRESS', 'SUBMITTED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!allowed[from]?.includes(to)) throw new InvalidTaskTransitionError(from, to);
}

export function transitionTask(input: { from: TaskStatus; to: TaskStatus; actorId: string; reason?: string; occurredAt?: Date }) {
  if (!input.actorId?.trim()) throw new Error('actorId is required');
  assertTaskTransition(input.from, input.to);
  if (['CANCELLED', 'REJECTED', 'OVERDUE'].includes(input.to) && !input.reason?.trim()) throw new Error(`reason is required for ${input.to}`);
  return { ...input, reason: input.reason?.trim(), occurredAt: input.occurredAt ?? new Date() };
}
