import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestContextValue, RequestTransport } from './base-microservice';

export class ContextVerificationError extends Error {
  readonly statusCode = 401;
  readonly code = 'UNAUTHENTICATED';
  constructor(message: string) { super(message); }
}

export function contextCanonicalPayload(context: Pick<RequestContextValue, 'tenantId' | 'buildingId' | 'apartmentId' | 'actorId' | 'subject' | 'sessionId' | 'rolesHeader' | 'scopes' | 'clientType' | 'contextTimestamp'>): string {
  return JSON.stringify([context.tenantId, context.buildingId ?? '', context.apartmentId ?? '', context.actorId ?? '', context.subject ?? '', context.sessionId ?? '', context.rolesHeader ?? '', context.scopes ?? [], context.clientType ?? '', context.contextTimestamp ?? '']);
}

export function createContextProof(secret: string, context: Omit<RequestContextValue, 'contextProof'>, timestamp = Date.now()): { proof: string; timestamp: string } {
  if (secret.length < 32) throw new ContextVerificationError('QHOME_CONTEXT_HMAC_SECRET must be at least 32 characters');
  const contextWithTimestamp = { ...context, contextTimestamp: String(timestamp) };
  const proof = createHmac('sha256', secret).update(contextCanonicalPayload(contextWithTimestamp), 'utf8').digest('hex');
  return { proof, timestamp: String(timestamp) };
}

export function verifyRequestContextProof(secret: string, context: RequestContextValue, proof: string | undefined, transport: RequestTransport, now = Date.now(), maxSkewMs = 300_000): void {
  if (!secret || secret.length < 32 || !proof) throw new ContextVerificationError(`authenticated context proof is required for ${transport}`);
  if (!context.contextTimestamp || !/^\d+$/u.test(context.contextTimestamp)) throw new ContextVerificationError('context timestamp is invalid');
  const timestamp = Number(context.contextTimestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxSkewMs) throw new ContextVerificationError('context proof has expired');
  if (!/^[0-9a-f]{64}$/iu.test(proof)) throw new ContextVerificationError('authenticated context proof is invalid');
  const expected = createHmac('sha256', secret).update(contextCanonicalPayload(context), 'utf8').digest();
  const provided = Buffer.from(proof, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ContextVerificationError('authenticated context proof is invalid');
}

export function isApartmentScopeAllowed(context: RequestContextValue, targetApartmentId: string): boolean {
  return isStaffContext(context) || Boolean(context.apartmentId && context.apartmentId === targetApartmentId);
}

export function isStaffContext(context: RequestContextValue): boolean {
  const allowlist = new Set(['ADMIN', 'MANAGER', 'BQL', 'BUILDING_ADMIN', 'PROJECT_ADMIN', 'STAFF', 'TECHNICIAN']);
  return (context.rolesHeader ?? '').split(/[ ,]+/u).filter(Boolean).some((role) => allowlist.has(role.toUpperCase()));
}
