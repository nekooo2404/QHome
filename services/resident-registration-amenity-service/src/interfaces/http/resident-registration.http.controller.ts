import { Body, Controller, Headers, Param, Patch, Post, Req, ForbiddenException } from '@nestjs/common';
import { ContextRequest, getRequestContext } from '../../../../../libs/common/src/base-microservice';
import { assertApartmentScope, assertStaffScope, isStaffContext } from '../../../../../libs/common/src/apartment-scope';
import { AmenityBookingService } from '../../application/booking.service';
import { RegistrationService } from '../../application/registration.service';

@Controller('/v1')
export class ResidentRegistrationHttpController {
  constructor(private readonly bookings: AmenityBookingService, private readonly registrations: RegistrationService) {}

  @Post('/amenity-bookings')
  reserve(@Req() request: ContextRequest, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { apartmentId: string; amenityId: string; timeSlotId: string; partySize: number }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, body.apartmentId);
    return this.bookings.reserve({ projectId: context.tenantId, residentId: context.actorId ?? '', idempotencyKey, apartmentId: body.apartmentId, amenityId: body.amenityId, timeSlotId: body.timeSlotId, partySize: body.partySize });
  }

  @Patch('/amenity-bookings/:bookingId/status')
  transitionBooking(@Req() request: ContextRequest, @Param('bookingId') bookingId: string, @Body() body: { apartmentId: string; expectedVersion: number; nextStatus: 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'COMPLETED'; paymentRef?: string }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, body.apartmentId);
    if (!isStaffContext(context) && body.nextStatus !== 'CANCELLED') throw new ForbiddenException('Residents can only cancel their own booking');
    if (isStaffContext(context)) assertStaffScope(context);
    return this.bookings.transition({ projectId: context.tenantId, bookingId, apartmentId: body.apartmentId, expectedVersion: body.expectedVersion, nextStatus: body.nextStatus, paymentRef: body.paymentRef });
  }

  @Post('/registrations')
  createRegistration(@Req() request: ContextRequest, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { apartmentId: string; type: string; payload: Record<string, unknown> }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, body.apartmentId);
    return this.registrations.create({ projectId: context.tenantId, residentId: context.actorId ?? '', apartmentId: body.apartmentId, type: body.type, payload: body.payload, idempotencyKey });
  }

  @Patch('/registrations/:requestId/status')
  transitionRegistration(@Req() request: ContextRequest, @Param('requestId') requestId: string, @Body() body: { apartmentId?: string; expectedVersion: number; currentStatus?: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'; nextStatus: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'; comment?: string }) {
    const context = getRequestContext(request);
    const staff = isStaffContext(context);
    const apartmentId = body.apartmentId ?? context.apartmentId;
    if (!staff) {
      assertApartmentScope(context, apartmentId ?? '');
      if (!['SUBMITTED', 'CANCELLED'].includes(body.nextStatus)) throw new ForbiddenException('Residents cannot approve or reject registrations');
    } else {
      assertStaffScope(context);
    }
    return this.registrations.transition({ projectId: context.tenantId, requestId, apartmentId, expectedVersion: body.expectedVersion, nextStatus: body.nextStatus, approverId: staff ? context.actorId ?? context.subject : undefined, comment: body.comment });
  }

  @Post('/registrations/:requestId/security-pass')
  issuePass(@Req() request: ContextRequest, @Param('requestId') requestId: string, @Body() body: { apartmentId: string; type: string; ttlMs: number }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, body.apartmentId);
    return this.registrations.issuePass({ projectId: context.tenantId, apartmentId: body.apartmentId, requestId, residentId: context.actorId ?? context.subject ?? '', type: body.type, ttlMs: body.ttlMs });
  }

  @Post('/security-passes/verify')
  verifyPass(@Req() request: ContextRequest, @Body() body: { token: string }) {
    const context = getRequestContext(request);
    return this.registrations.verifyPass(body.token, context.tenantId);
  }
}
