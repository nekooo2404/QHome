export type TicketStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_RESIDENT' | 'RESOLVED' | 'CLOSED' | 'REJECTED';

export class InvalidTicketTransitionError extends Error {
  readonly code = 'INVALID_TICKET_TRANSITION';
  constructor(readonly from: TicketStatus, readonly to: TicketStatus) { super(`Invalid ticket transition ${from} -> ${to}`); }
}

const transitions: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'REJECTED'],
  ASSIGNED: ['IN_PROGRESS', 'REJECTED'],
  IN_PROGRESS: ['WAITING_RESIDENT', 'RESOLVED', 'REJECTED'],
  WAITING_RESIDENT: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  REJECTED: [],
};

export function assertTicketTransition(from: TicketStatus, to: TicketStatus): void {
  if (!transitions[from]?.includes(to)) throw new InvalidTicketTransitionError(from, to);
}
