import { BookingStatus, WorkflowStatus } from '../domain/booking';

export interface RedisLockClient {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface DistributedLock {
  acquire(key: string, ttlMs: number): Promise<{ expiresAt: number; remainingTtl(): number; assertRemaining(minimumMs: number): void; release(): Promise<void> } | null>;
}

export interface DelayedQueue {
  add(name: string, data: Record<string, unknown>, options: { jobId: string; delay: number; attempts: number }): Promise<void>;
}

export interface BookingRepository {
  reserve(input: { projectId: string; residentId: string; apartmentId: string; amenityId: string; timeSlotId: string; idempotencyKey: string; partySize: number; paymentDueAt: Date }, lockCheck?: () => void): Promise<{ id: string; status: BookingStatus; paymentDueAt: Date }>;
  transitionBooking(input: { projectId: string; bookingId: string; apartmentId?: string; expectedVersion: number; nextStatus: BookingStatus; paymentRef?: string }): Promise<unknown>;
  releaseExpiredBooking(bookingId: string, now: Date): Promise<boolean>;
  releaseHeldBooking(projectId: string, bookingId: string): Promise<boolean>;
}

export interface RegistrationRepository {
  create(input: { projectId: string; residentId: string; apartmentId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<{ id: string; status: WorkflowStatus }>;
  transition(input: { projectId: string; requestId: string; apartmentId?: string; expectedVersion: number; nextStatus: WorkflowStatus; approverId?: string; comment?: string }): Promise<unknown>;
  assertRegistrationApproved(input: { projectId: string; requestId: string; residentId: string; apartmentId: string }): Promise<void>;
  issueSecurityPass(input: { projectId: string; apartmentId: string; requestId: string; residentId: string; type: string; payloadHash: string; validFrom: Date; expiresAt: Date; jti: string }): Promise<unknown>;
  revokeSecurityPass(jti: string): Promise<void>;
  consumeSecurityPass(jti: string, now: Date): Promise<boolean>;
}

export interface EventPublisher {
  publish(input: { eventId: string; projectId: string; eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> }): Promise<void>;
}
