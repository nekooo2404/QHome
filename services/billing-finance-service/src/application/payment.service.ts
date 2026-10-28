import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { decimal } from '../domain/finance.types';
import { IdempotencyGate, LedgerAccountRepository, PaymentRepository } from './ports';

export interface PaymentCommand {
  projectId: string;
  apartmentId: string;
  residentId?: string;
  provider: string;
  providerTransactionId: string;
  providerEventId?: string;
  idempotencyKey: string;
  channel: 'BANK_TRANSFER' | 'E_WALLET' | 'VIETQR' | 'CASH';
  currencyCode: string;
  grossAmount: string;
  providerOccurredAt?: Date;
  rawReference?: string;
  webhookReceipt?: { timestamp: Date; signature: string; payloadHash: string };
}

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly accounts: LedgerAccountRepository,
    private readonly idempotency: IdempotencyGate,
  ) {}

  async applyPayment(command: PaymentCommand): Promise<{ paymentId: string; appliedAmount: string; surplusAmount: string; invoiceIds: string[] }> {
    const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const scope = `payment:${command.projectId}:${command.apartmentId}`;
    const gate = await this.idempotency.begin(scope, command.idempotencyKey, requestHash, 86_400);
    if (!gate.acquired) {
      if (!gate.cachedResponse) throw new Error('Payment request is already being processed');
      if (gate.cachedResponse.statusCode >= 500) {
        const error = new Error('Cached payment processing failure');
        Object.assign(error, { statusCode: gate.cachedResponse.statusCode, code: 'PAYMENT_PROCESSING_FAILED' });
        throw error;
      }
      return gate.cachedResponse.body as { paymentId: string; appliedAmount: string; surplusAmount: string; invoiceIds: string[] };
    }

    try {
      const grossAmount = decimal(command.grossAmount);
      if (!grossAmount.isFinite() || grossAmount.isNegative() || grossAmount.isZero()) throw new Error('grossAmount must be positive');
      const result = await this.repository.applyPayment({
        ...command,
        grossAmount,
      });
      const response = { paymentId: result.paymentId, appliedAmount: result.appliedAmount.toFixed(), surplusAmount: result.surplusAmount.toFixed(), invoiceIds: result.invoiceIds };
      await this.idempotency.complete(scope, command.idempotencyKey, requestHash, 200, response);
      return response;
    } catch (error) {
      await this.idempotency.abort(scope, command.idempotencyKey, requestHash).catch(() => undefined);
      throw error;
    }
  }
}
