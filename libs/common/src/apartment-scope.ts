import { ForbiddenException } from '@nestjs/common';
import type { RequestContextValue } from './base-microservice';
import { isApartmentScopeAllowed as isAllowed } from './context-proof';
import { isStaffContext } from './context-proof';

export function assertApartmentScope(context: RequestContextValue, targetApartmentId: string): void {
  if (!isAllowed(context, targetApartmentId)) throw new ForbiddenException('Cross-apartment access denied');
}

export function isApartmentScopeAllowed(context: RequestContextValue, targetApartmentId: string): boolean {
  return isAllowed(context, targetApartmentId);
}

export function assertStaffScope(context: RequestContextValue): void {
  if (!isStaffContext(context)) throw new ForbiddenException('Staff or management role is required');
}

export function assertActorScope(context: RequestContextValue, targetActorId: string): void {
  if (!isStaffContext(context) && context.subject !== targetActorId) throw new ForbiddenException('Cross-resident access denied');
}
