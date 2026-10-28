import { Body, Controller, Headers, Param, Patch, Post } from '@nestjs/common';
import { AmenityBookingService } from '../../application/booking.service';
import { RegistrationService } from '../../application/registration.service';

@Controller('/v1')
export class ResidentRegistrationHttpController {
  constructor(private readonly bookings: AmenityBookingService, private readonly registrations: RegistrationService) {}

  @Post('/amenity-bookings')
  reserve(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') residentId: string, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { apartmentId: string; amenityId: string; timeSlotId: string; partySize: number; paymentDueAt: string }) {
    return this.bookings.reserve({ projectId, residentId, idempotencyKey, apartmentId: body.apartmentId, amenityId: body.amenityId, timeSlotId: body.timeSlotId, partySize: body.partySize, paymentDueAt: new Date(body.paymentDueAt) });
  }

  @Patch('/amenity-bookings/:bookingId/status')
  transitionBooking(@Headers('x-tenant-id') projectId: string, @Param('bookingId') bookingId: string, @Body() body: { expectedVersion: number; nextStatus: 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'COMPLETED'; paymentRef?: string }) {
    return this.bookings.transition({ projectId, bookingId, expectedVersion: body.expectedVersion, nextStatus: body.nextStatus, paymentRef: body.paymentRef });
  }

  @Post('/registrations')
  createRegistration(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') residentId: string, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { apartmentId: string; type: string; payload: Record<string, unknown> }) {
    return this.registrations.create({ projectId, residentId, apartmentId: body.apartmentId, type: body.type, payload: body.payload, idempotencyKey });
  }

  @Patch('/registrations/:requestId/status')
  transitionRegistration(@Headers('x-tenant-id') projectId: string, @Param('requestId') requestId: string, @Body() body: { expectedVersion: number; currentStatus: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'; nextStatus: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'; approverId?: string; comment?: string }) {
    return this.registrations.transition({ projectId, requestId, ...body });
  }

  @Post('/registrations/:requestId/security-pass')
  issuePass(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') residentId: string, @Param('requestId') requestId: string, @Body() body: { type: string; ttlMs: number }) {
    return this.registrations.issuePass({ projectId, requestId, residentId, type: body.type, ttlMs: body.ttlMs });
  }

  @Post('/security-passes/verify')
  verifyPass(@Body() body: { token: string }) {
    return this.registrations.verifyPass(body.token);
  }
}
