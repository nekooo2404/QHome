import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { BookingRepository, RegistrationRepository } from '../../application/ports';
import { BookingStatus, WorkflowStatus } from '../../domain/booking';

type Tx = Prisma.TransactionClient;

function outbox(projectId: string, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  return { eventId: randomUUID(), projectId, topic: 'qhome.resident-registration.events.v1', eventType, aggregateType, aggregateId, payload: payload as Prisma.InputJsonValue, headers: {} };
}

export class PrismaRegistrationRepository implements BookingRepository, RegistrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(input: { projectId: string; residentId: string; apartmentId: string; amenityId: string; timeSlotId: string; idempotencyKey: string; partySize: number; paymentDueAt: Date }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.amenityBooking.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { id: existing.id, status: existing.status as BookingStatus, paymentDueAt: existing.paymentDueAt! };

      const slots = await tx.$queryRawUnsafe<Array<{ id: string; amenity_id: string; starts_at: Date; ends_at: Date; capacity: number; reserved_count: number }>>(
        `SELECT s.id, s.amenity_id, s.starts_at, s.ends_at, s.capacity, s.reserved_count FROM amenity_time_slots s JOIN amenities a ON a.id = s.amenity_id WHERE s.id = $1::uuid AND a.project_id = $2::uuid AND a.status = 'ACTIVE' FOR UPDATE`,
        input.timeSlotId,
        input.projectId,
      );
      const slot = slots[0];
      if (!slot) throw new Error('Amenity slot is not available');
      if (slot.reserved_count + input.partySize > slot.capacity) throw new Error('Amenity slot capacity exceeded');

      const booking = await tx.amenityBooking.create({ data: { projectId: input.projectId, residentId: input.residentId, apartmentId: input.apartmentId, amenityId: input.amenityId, timeSlotId: input.timeSlotId, idempotencyKey: input.idempotencyKey, status: 'PENDING_PAYMENT', partySize: input.partySize, startsAt: slot.starts_at, endsAt: slot.ends_at, paymentDueAt: input.paymentDueAt } });
      await tx.amenityTimeSlot.update({ where: { id: slot.id }, data: { reservedCount: { increment: input.partySize }, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'amenity.booking.held.v1', 'amenity_booking', booking.id, { bookingId: booking.id, amenityId: input.amenityId, timeSlotId: input.timeSlotId, paymentDueAt: input.paymentDueAt.toISOString() }) });
      return { id: booking.id, status: booking.status as BookingStatus, paymentDueAt: booking.paymentDueAt! };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async transitionBooking(input: { projectId: string; bookingId: string; expectedVersion: number; nextStatus: BookingStatus; paymentRef?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.amenityBooking.findFirst({ where: { id: input.bookingId, projectId: input.projectId, version: input.expectedVersion } });
      if (!booking) throw new Error('Booking not found or version conflict');
      const updated = await tx.amenityBooking.update({ where: { id: booking.id }, data: { status: input.nextStatus, paymentRef: input.paymentRef, version: { increment: 1 } } });
      if (input.nextStatus === 'CANCELLED' || input.nextStatus === 'EXPIRED') await tx.amenityTimeSlot.update({ where: { id: booking.timeSlotId }, data: { reservedCount: { decrement: booking.partySize }, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'amenity.booking.status_changed.v1', 'amenity_booking', booking.id, { from: booking.status, to: input.nextStatus, bookingId: booking.id }) });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async releaseExpiredBooking(bookingId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.amenityBooking.findUnique({ where: { id: bookingId } });
      if (!booking || !['HELD', 'PENDING_PAYMENT'].includes(booking.status) || !booking.paymentDueAt || booking.paymentDueAt > now) return false;
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string; party_size: number; time_slot_id: string; project_id: string }>>('SELECT id, status, party_size, time_slot_id, project_id FROM amenity_bookings WHERE id = $1::uuid FOR UPDATE', bookingId);
      if (locked.length === 0 || !['HELD', 'PENDING_PAYMENT'].includes(locked[0].status)) return false;
      await tx.amenityBooking.update({ where: { id: bookingId }, data: { status: 'EXPIRED', version: { increment: 1 } } });
      await tx.amenityTimeSlot.update({ where: { id: locked[0].time_slot_id }, data: { reservedCount: { decrement: locked[0].party_size }, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox(locked[0].project_id, 'amenity.booking.expired.v1', 'amenity_booking', bookingId, { bookingId }) });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async create(input: { projectId: string; residentId: string; apartmentId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.registrationRequest.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { id: existing.id, status: existing.status as WorkflowStatus };
      const request = await tx.registrationRequest.create({ data: { projectId: input.projectId, residentId: input.residentId, apartmentId: input.apartmentId, type: input.type as 'VEHICLE' | 'ELEVATOR_CARD' | 'PARKING_CARD' | 'APARTMENT_ACCESS_CARD' | 'REPAIR' | 'MOVING', idempotencyKey: input.idempotencyKey, payload: input.payload as Prisma.InputJsonValue } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'registration.request.submitted.v1', 'registration_request', request.id, { requestId: request.id, type: input.type }) });
      return { id: request.id, status: request.status as WorkflowStatus };
    });
  }

  async transition(input: { projectId: string; requestId: string; expectedVersion: number; nextStatus: WorkflowStatus; approverId?: string; comment?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.registrationRequest.findFirst({ where: { id: input.requestId, projectId: input.projectId, version: input.expectedVersion } });
      if (!request) throw new Error('Registration request not found or version conflict');
      const updated = await tx.registrationRequest.update({ where: { id: request.id }, data: { status: input.nextStatus, version: { increment: 1 }, submittedAt: input.nextStatus === 'SUBMITTED' ? new Date() : undefined, completedAt: input.nextStatus === 'COMPLETED' ? new Date() : undefined } });
      if (input.approverId) await tx.approvalAction.create({ data: { requestId: request.id, step: request.version, approverId: input.approverId, decision: input.nextStatus === 'APPROVED' ? 'APPROVED' : input.nextStatus === 'REJECTED' ? 'REJECTED' : 'REQUESTED_CHANGES', comment: input.comment } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'registration.request.status_changed.v1', 'registration_request', request.id, { requestId: request.id, from: request.status, to: input.nextStatus }) });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async issueSecurityPass(input: { projectId: string; requestId: string; residentId: string; type: string; payloadHash: string; validFrom: Date; expiresAt: Date; jti: string }) {
    return this.prisma.$transaction(async (tx) => {
      const pass = await tx.securityPass.create({ data: { projectId: input.projectId, requestId: input.requestId, jti: input.jti, payloadHash: input.payloadHash, validFrom: input.validFrom, expiresAt: input.expiresAt } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'security.pass.issued.v1', 'security_pass', pass.id, { passId: pass.id, requestId: input.requestId, jti: input.jti }) });
      return pass;
    });
  }

  revokeSecurityPass(jti: string) { return this.prisma.securityPass.update({ where: { jti }, data: { status: 'REVOKED', revokedAt: new Date() } }).then(() => undefined); }
  async isPassUsable(jti: string, now: Date) { const pass = await this.prisma.securityPass.findUnique({ where: { jti } }); return Boolean(pass && pass.status === 'ACTIVE' && pass.validFrom <= now && pass.expiresAt > now); }
}
