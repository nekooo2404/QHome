import Decimal from 'decimal.js';
import { InvoiceSnapshot, LedgerTransactionInput, PaymentApplicationPlan } from '../domain/finance.types';

export interface IdempotencyGate {
  begin(scope: string, key: string, requestHash: string, ttlSeconds: number): Promise<{ acquired: boolean; cachedResponse?: { statusCode: number; body: unknown } }>;
  complete(scope: string, key: string, requestHash: string, statusCode: number, body: unknown): Promise<void>;
}

export interface DistributedLock {
  acquire(resource: string, ttlMs: number): Promise<{ token: string; release(): Promise<void> }>;
}

export interface PaymentRepository {
  applyPayment(input: {
    projectId: string;
    apartmentId: string;
    residentId?: string;
    provider: string;
    providerTransactionId: string;
    providerEventId?: string;
    idempotencyKey: string;
    channel: 'BANK_TRANSFER' | 'E_WALLET' | 'VIETQR' | 'CASH';
    currencyCode: string;
    grossAmount: Decimal;
    providerOccurredAt?: Date;
    rawReference?: string;
    webhookReceipt?: { timestamp: Date; signature: string; payloadHash: string };
    plan: PaymentApplicationPlan;
    ledger: LedgerTransactionInput;
  }): Promise<{ paymentId: string; appliedAmount: Decimal; surplusAmount: Decimal; invoiceIds: string[] }>;
  loadOpenInvoicesForApartment(projectId: string, apartmentId: string, currencyCode: string): Promise<InvoiceSnapshot[]>;
  findOutstandingInvoices(projectId: string, apartmentIds: string[], cursor?: string, limit?: number): Promise<{ items: InvoiceSnapshot[]; nextCursor?: string }>;
  getConsumptionHistory(projectId: string, apartmentId: string, from: Date, to: Date): Promise<Array<{ periodStart: Date; periodEnd: Date; electricity: Decimal; water: Decimal }>>;
  createBillingBatchJob(input: { projectId: string; billingPeriodId: string }): Promise<string>;
}

export interface InvoiceIssueRepository {
  issueBatch(input: {
    projectId: string;
    billingPeriodId: string;
    items: Array<{
      apartmentId: string;
      residentId?: string;
      serviceId: string;
      description: string;
      quantity: Decimal;
      unitPrice: Decimal;
      netAmount: Decimal;
      vatAmount: Decimal;
      totalAmount: Decimal;
      currencyCode: string;
      pricingSnapshot: Record<string, unknown>;
    }>;
  }): Promise<{ invoiceIds: string[] }>;
}

export interface LedgerAccountRepository {
  getAccountId(projectId: string, accountCode: string, currencyCode: string): Promise<string>;
}

export interface OutboxPublisher {
  publish(input: { topic: string; eventId: string; eventType: string; aggregateType: string; aggregateId: string; projectId?: string; payload: Record<string, unknown> }): Promise<void>;
}

export interface PricingBatchClient {
  calculateBatch(input: Array<{ apartmentId: string; pricingPlanId: string; quantity: Decimal; context: Record<string, string> }>): Promise<Array<{ apartmentId: string; serviceId: string; description: string; quantity: Decimal; unitPrice: Decimal; netAmount: Decimal; vatAmount: Decimal; totalAmount: Decimal; currencyCode: string; pricingSnapshot: Record<string, unknown> }>>;
}

export interface ApartmentSnapshotClient {
  listBillableApartments(projectId: string, billingPeriodId: string, cursor?: string, limit?: number): Promise<{ items: Array<{ apartmentId: string; residentId?: string; areaSqm: Decimal; headcount: Decimal; vehicleCount: Decimal }>; nextCursor?: string }>;
}

export interface QueueLike {
  add(name: string, data: Record<string, unknown>, options?: { jobId?: string; attempts?: number; backoff?: { type: string; delay: number } }): Promise<void>;
}

export interface ReportRepository {
  cashFlow(projectId: string, from: Date, to: Date): Promise<Array<{ accountCode: string; debit: Decimal; credit: Decimal; net: Decimal }>>;
  receivables(projectId: string, asOf: Date): Promise<Array<{ apartmentId: string; invoiceCount: number; outstanding: Decimal }>>;
}
