import { BookingStatus, WorkflowStatus } from '../domain/booking';

export interface RedisLockClient {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface DistributedLock {
  acquire(key: string, ttlMs: number): Promise<{ release(): Promise<void> } | null>;
}

export interface DelayedQueue {
  add(name: string, data: Record<string, unknown>, options: { jobId: string; delay: number; attempts: number }): Promise<void>;
}

export interface BookingRepository {
  reserve(input: { projectId: string; residentId: string; apartmentId: string; amenityId: string; timeSlotId: string; idempotencyKey: string; partySize: number; paymentDueAt: Date }): Promise<{ id: string; status: BookingStatus; paymentDueAt: Date }>;
  transitionBooking(input: { projectId: string; bookingId: string; expectedVersion: number; nextStatus: BookingStatus; paymentRef?: string }): Promise<unknown>;
  releaseExpiredBooking(bookingId: string, now: Date): Promise<boolean>;
}

export interface RegistrationRepository {
  create(input: { projectId: string; residentId: string; apartmentId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<{ id: string; status: WorkflowStatus }>;
  transition(input: { projectId: string; requestId: string; expectedVersion: number; nextStatus: WorkflowStatus; approverId?: string; comment?: string }): Promise<unknown>;
  issueSecurityPass(input: { projectId: string; requestId: string; residentId: string; type: string; payloadHash: string; validFrom: Date; expiresAt: Date; jti: string }): Promise<unknown>;
  revokeSecurityPass(jti: string): Promise<void>;
  isPassUsable(jti: string, now: Date): Promise<boolean>;
}

export interface EventPublisher {
  publish(input: { eventId: string; projectId: string; eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> }): Promise<void>;
}
