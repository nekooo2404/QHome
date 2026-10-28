import Decimal from 'decimal.js';
import { PricingCalculationContext, PricingCalculationResult, PricingPlanSnapshot } from '../domain/pricing.types';

export interface PricingPlanRepository {
  getSnapshot(planId: string, at: Date): Promise<PricingPlanSnapshot>;
}

export interface SmartCardRecord {
  id: string;
  projectId: string;
  residentId: string;
  apartmentId: string | null;
  type: 'ELEVATOR' | 'PARKING' | 'APARTMENT_ACCESS';
  chipUid: string;
  externalNumber: string;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'REVOKED' | 'EXPIRED';
  blockReason: 'OVERDUE_DEBT' | 'LOST' | 'SECURITY_INCIDENT' | 'ADMINISTRATIVE' | null;
  blockedAt: Date | null;
}

export interface CardRepository {
  issue(input: { projectId: string; residentId: string; apartmentId?: string; type: SmartCardRecord['type']; chipUid: string; externalNumber: string; expiresAt?: Date }): Promise<SmartCardRecord>;
  block(cardId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<SmartCardRecord>;
  unblock(cardId: string): Promise<SmartCardRecord>;
  revoke(cardId: string): Promise<SmartCardRecord>;
  blockActiveCardsByResident(projectId: string, residentId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<number>;
}

export interface InboxRepository {
  processOnce<T>(input: { eventId: string; eventType: string; handler: () => Promise<T> }): Promise<{ processed: boolean; result?: T }>;
}

export interface RetryPublisher {
  publishRetry(input: { eventId: string; eventType: string; payload: Record<string, unknown>; attempt: number; availableAt: Date }): Promise<void>;
  publishDlq(input: { eventId: string; eventType: string; payload: Record<string, unknown>; attempts: number; error: string }): Promise<void>;
}

export interface PricingCalculationRequest {
  pricingPlanId: string;
  context: PricingCalculationContext;
}

export interface PricingApplicationService {
  calculate(request: PricingCalculationRequest): Promise<PricingCalculationResult>;
}

export interface CardLifecycleService {
  issue(input: Parameters<CardRepository['issue']>[0]): Promise<SmartCardRecord>;
  block(cardId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<SmartCardRecord>;
  unblock(cardId: string): Promise<SmartCardRecord>;
  revoke(cardId: string): Promise<SmartCardRecord>;
  handleDebtOverdue(event: { eventId: string; projectId: string; residentId: string }): Promise<number>;
  handleDebtOverdueWithRetry(event: { eventId: string; projectId: string; residentId: string }, attempt?: number): Promise<void>;
}

export type DecimalOnly = Decimal;
