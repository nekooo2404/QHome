import { createHash } from 'node:crypto';
import { BookingRepository, DelayedQueue, DistributedLock } from './ports';
import { BookingStatus } from '../domain/booking';

export class AmenityBookingService {
  constructor(private readonly repository: BookingRepository, private readonly lock: DistributedLock, private readonly queue: DelayedQueue, private readonly lockTtlMs = 15_000) {}

  async reserve(input: { projectId: string; residentId: string; apartmentId: string; amenityId: string; timeSlotId: string; idempotencyKey: string; partySize: number }) {
    if (!Number.isInteger(input.partySize) || input.partySize < 1) throw new Error('partySize must be a positive integer');
    const paymentDueAt = new Date(Date.now() + 10 * 60_000);
    const lock = await this.lock.acquire('amenity:' + input.amenityId + ':slot:' + input.timeSlotId, this.lockTtlMs);
    if (!lock) throw new Error('Amenity slot is busy; retry shortly');
    let booking: { id: string; status: BookingStatus; paymentDueAt: Date } | undefined;
    try {
      lock.assertRemaining(2000);
      booking = await this.repository.reserve({ ...input, paymentDueAt }, lock.assertRemaining.bind(lock, 2000));
      lock.assertRemaining(2000);
      await this.queue.add('expire-amenity-hold', { bookingId: booking.id }, { jobId: 'booking-expiry:' + booking.id, delay: Math.max(0, paymentDueAt.getTime() - Date.now()), attempts: 5 });
      return booking;
    } catch (error) {
      if (booking) await this.repository.releaseHeldBooking(input.projectId, booking.id);
      throw error;
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
