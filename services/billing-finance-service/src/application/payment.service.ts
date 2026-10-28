import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { assertBalancedLedger, decimal, planPaymentApplication } from '../domain/finance.types';
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
      return gate.cachedResponse.body as { paymentId: string; appliedAmount: string; surplusAmount: string; invoiceIds: string[] };
    }

    try {
      const grossAmount = decimal(command.grossAmount);
      if (!grossAmount.isFinite() || grossAmount.isNegative() || grossAmount.isZero()) throw new Error('grossAmount must be positive');
      const invoices = await this.repository.loadOpenInvoicesForApartment(command.projectId, command.apartmentId, command.currencyCode);
      const plan = planPaymentApplication(grossAmount, invoices);
      await this.accounts.getAccountId(command.projectId, 'BANK_CASH', command.currencyCode);
      await this.accounts.getAccountId(command.projectId, 'ACCOUNTS_RECEIVABLE', command.currencyCode);
      await this.accounts.getAccountId(command.projectId, 'APARTMENT_WALLET_LIABILITY', command.currencyCode);
      const lines = [
        { accountCode: 'BANK_CASH', side: 'DEBIT' as const, amount: grossAmount, currencyCode: command.currencyCode, apartmentId: command.apartmentId, description: 'Payment received' },
        { accountCode: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT' as const, amount: plan.appliedAmount, currencyCode: command.currencyCode, apartmentId: command.apartmentId, description: 'Invoice settlement' },
        ...(plan.surplus.isZero() ? [] : [{ accountCode: 'APARTMENT_WALLET_LIABILITY', side: 'CREDIT' as const, amount: plan.surplus, currencyCode: command.currencyCode, apartmentId: command.apartmentId, description: 'Payment surplus credited to apartment wallet' }]),
      ];
      assertBalancedLedger(lines);
      const result = await this.repository.applyPayment({
        ...command,
        grossAmount,
        plan,
        ledger: { projectId: command.projectId, referenceType: 'PAYMENT', referenceId: `${command.provider}:${command.providerTransactionId}`, description: 'Payment settlement', lines },
      });
      const response = { paymentId: result.paymentId, appliedAmount: result.appliedAmount.toFixed(), surplusAmount: result.surplusAmount.toFixed(), invoiceIds: result.invoiceIds };
      await this.idempotency.complete(scope, command.idempotencyKey, requestHash, 200, response);
      return response;
    } catch (error) {
      await this.idempotency.complete(scope, command.idempotencyKey, requestHash, 500, { error: 'PAYMENT_PROCESSING_FAILED' }).catch(() => undefined);
      throw error;
    }
  }
}
