import Decimal from 'decimal.js';

export type DecimalValue = Decimal | string;

export function decimal(value: DecimalValue): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function nonNegative(value: Decimal, name: string): void {
  if (!value.isFinite() || value.isNegative()) throw new Error(`${name} must be finite and non-negative`);
}

export interface InvoiceSnapshot {
  id: string;
  projectId: string;
  apartmentId: string;
  currencyCode: string;
  totalAmount: Decimal;
  paidAmount: Decimal;
  status: 'ISSUED' | 'PARTIALLY_PAID' | 'OVERDUE';
}

export interface PaymentAllocationPlan {
  invoiceId: string;
  amount: Decimal;
}

export interface PaymentApplicationPlan {
  allocations: PaymentAllocationPlan[];
  surplus: Decimal;
  appliedAmount: Decimal;
}

export interface LedgerLineInput {
  accountCode: string;
  side: 'DEBIT' | 'CREDIT';
  amount: Decimal;
  currencyCode: string;
  apartmentId?: string;
  description: string;
}

export interface LedgerTransactionInput {
  projectId: string;
  referenceType: string;
  referenceId: string;
  description: string;
  lines: LedgerLineInput[];
}

export function planPaymentApplication(paymentAmount: Decimal, invoices: InvoiceSnapshot[]): PaymentApplicationPlan {
  nonNegative(paymentAmount, 'paymentAmount');
  let remaining = paymentAmount;
  const allocations: PaymentAllocationPlan[] = [];
  for (const invoice of invoices) {
    if (remaining.isZero()) break;
    const due = invoice.totalAmount.minus(invoice.paidAmount);
    nonNegative(due, `invoice ${invoice.id} due amount`);
    if (due.isZero()) continue;
    const amount = Decimal.min(remaining, due);
    allocations.push({ invoiceId: invoice.id, amount });
    remaining = remaining.minus(amount);
  }
  return { allocations, surplus: remaining, appliedAmount: paymentAmount.minus(remaining) };
}

export function assertBalancedLedger(lines: LedgerLineInput[]): void {
  if (lines.length < 2) throw new Error('A ledger transaction requires at least two entries');
  const currencies = new Set(lines.map((line) => line.currencyCode));
  if (currencies.size !== 1) throw new Error('A ledger transaction cannot mix currencies');
  let debits = new Decimal(0);
  let credits = new Decimal(0);
  for (const line of lines) {
    nonNegative(line.amount, 'ledger amount');
    if (!line.amount.isPositive()) throw new Error('Ledger amount must be positive');
    if (line.side === 'DEBIT') debits = debits.plus(line.amount);
    else credits = credits.plus(line.amount);
  }
  if (!debits.eq(credits)) throw new Error(`Unbalanced ledger: debit=${debits.toFixed()} credit=${credits.toFixed()}`);
}
