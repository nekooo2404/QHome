import { createHash } from 'node:crypto';
import { BookingRepository, DelayedQueue, DistributedLock } from './ports';

export class AmenityBookingService {
  constructor(private readonly repository: BookingRepository, private readonly lock: DistributedLock, private readonly queue: DelayedQueue, private readonly lockTtlMs = 15_000) {}

  async reserve(input: { projectId: string; residentId: string; apartmentId: string; amenityId: string; timeSlotId: string; idempotencyKey: string; partySize: number; paymentDueAt: Date }) {
    if (!Number.isInteger(input.partySize) || input.partySize < 1) throw new Error('partySize must be a positive integer');
    const lock = await this.lock.acquire('amenity:' + input.amenityId + ':slot:' + input.timeSlotId, this.lockTtlMs);
    if (!lock) throw new Error('Amenity slot is busy; retry shortly');
    try {
      const booking = await this.repository.reserve(input);
      await this.queue.add('expire-amenity-hold', { bookingId: booking.id }, { jobId: 'booking-expiry:' + booking.id, delay: Math.max(0, input.paymentDueAt.getTime() - Date.now()), attempts: 5 });
      return booking;
    } finally {
      await lock.release();
    }
  }

  transition(input: Parameters<BookingRepository['transitionBooking']>[0]) {
    return this.repository.transitionBooking(input);
  }

  async expireHold(bookingId: string): Promise<{ expired: boolean }> {
    return { expired: await this.repository.releaseExpiredBooking(bookingId, new Date()) };
  }

  requestHash(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
}
