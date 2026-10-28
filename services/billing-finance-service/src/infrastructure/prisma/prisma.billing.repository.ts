import { Prisma, PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { InvoiceIssueRepository, LedgerAccountRepository, PaymentRepository, ReportRepository } from '../../application/ports';
import { InvoiceSnapshot, LedgerTransactionInput, PaymentApplicationPlan, planPaymentApplication } from '../../domain/finance.types';

type Tx = Prisma.TransactionClient;

const asDecimal = (value: unknown): Decimal => new Decimal(String(value));
const isSerializationConflict = (error: unknown): boolean => (error as { code?: string }).code === 'P2034';

export class PrismaBillingRepository implements PaymentRepository, InvoiceIssueRepository, LedgerAccountRepository, ReportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadOpenInvoicesForApartment(projectId: string, apartmentId: string, currencyCode: string): Promise<InvoiceSnapshot[]> {
    const rows = await this.prisma.invoice.findMany({ where: { projectId, apartmentId, currencyCode, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ id: row.id, projectId: row.projectId, apartmentId: row.apartmentId, currencyCode: row.currencyCode, totalAmount: asDecimal(row.totalAmount), paidAmount: asDecimal(row.paidAmount), status: row.status as InvoiceSnapshot['status'] }));
  }

  async applyPayment(input: {
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
  }): Promise<{ paymentId: string; appliedAmount: Decimal; surplusAmount: Decimal; invoiceIds: string[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.applyPaymentTransaction(tx, input), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
      } catch (error) {
        if (!isSerializationConflict(error) || attempt === 2) throw error;
      }
    }
    throw new Error('Payment transaction retry budget exhausted');
  }

  private async applyPaymentTransaction(tx: Tx, input: {
    projectId: string; apartmentId: string; residentId?: string; provider: string; providerTransactionId: string; providerEventId?: string; idempotencyKey: string;
    channel: 'BANK_TRANSFER' | 'E_WALLET' | 'VIETQR' | 'CASH'; currencyCode: string; grossAmount: Decimal; providerOccurredAt?: Date; rawReference?: string;
    webhookReceipt?: { timestamp: Date; signature: string; payloadHash: string };
    plan: PaymentApplicationPlan; ledger: LedgerTransactionInput;
  }) {
    const existing = await tx.paymentTransaction.findUnique({ where: { provider_providerTransactionId: { provider: input.provider, providerTransactionId: input.providerTransactionId } }, include: { allocations: true } });
    if (existing) {
      if (!asDecimal(existing.grossAmount).eq(input.grossAmount) || existing.currencyCode !== input.currencyCode || existing.apartmentId !== input.apartmentId) throw new Error('Provider transaction conflicts with an existing payment');
      return { paymentId: existing.id, appliedAmount: asDecimal(existing.appliedAmount), surplusAmount: asDecimal(existing.surplusAmount), invoiceIds: existing.allocations.map((allocation) => allocation.invoiceId) };
    }

    const ids = input.plan.allocations.map((allocation) => allocation.invoiceId);
    const lockedRows = ids.length === 0 ? [] : await tx.$queryRawUnsafe<Array<{ id: string; total_amount: Prisma.Decimal; paid_amount: Prisma.Decimal; status: string }>>(
      `SELECT id, total_amount, paid_amount, status FROM invoices WHERE project_id = $1::uuid AND apartment_id = $2::uuid AND id = ANY($3::uuid[]) AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') ORDER BY due_at ASC, created_at ASC, id ASC FOR UPDATE`,
      input.projectId,
      input.apartmentId,
      ids,
    );
    if (lockedRows.length !== ids.length) throw new Error('One or more invoices are not payable in this apartment');
    const invoices = lockedRows.map((row) => ({ id: row.id, projectId: input.projectId, apartmentId: input.apartmentId, currencyCode: input.currencyCode, totalAmount: asDecimal(row.total_amount), paidAmount: asDecimal(row.paid_amount), status: row.status as InvoiceSnapshot['status'] }));
    const verified = planPaymentApplication(input.grossAmount, invoices);
    if (!verified.appliedAmount.eq(input.plan.appliedAmount) || !verified.surplus.eq(input.plan.surplus)) throw new Error('Payment allocation changed while processing');

    const payment = await tx.paymentTransaction.create({ data: {
      projectId: input.projectId, apartmentId: input.apartmentId, residentId: input.residentId, provider: input.provider, providerTransactionId: input.providerTransactionId, idempotencyKey: input.idempotencyKey,
      channel: input.channel, status: 'APPLIED', currencyCode: input.currencyCode, grossAmount: input.grossAmount.toFixed(12), appliedAmount: verified.appliedAmount.toFixed(12), surplusAmount: verified.surplus.toFixed(12),
      providerOccurredAt: input.providerOccurredAt, rawReference: input.rawReference,
    } });
    if (input.providerEventId && input.webhookReceipt) {
      await tx.webhookReceipt.create({ data: { provider: input.provider, providerEventId: input.providerEventId, timestamp: input.webhookReceipt.timestamp, signature: input.webhookReceipt.signature, payloadHash: input.webhookReceipt.payloadHash } });
    }
    for (const allocation of verified.allocations) {
      const invoice = invoices.find((candidate) => candidate.id === allocation.invoiceId)!;
      const paidAfter = invoice.paidAmount.plus(allocation.amount);
      const status = paidAfter.greaterThanOrEqualTo(invoice.totalAmount) ? 'PAID' : 'PARTIALLY_PAID';
      await tx.invoice.update({ where: { id: invoice.id }, data: { paidAmount: paidAfter.toFixed(12), status, version: { increment: 1 } } });
      await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: invoice.id, amount: allocation.amount.toFixed(12) } });
      await tx.outboxEvent.create({ data: { eventId: payment.id + ':invoice:' + invoice.id, projectId: input.projectId, topic: 'qhome.billing.events.v1', eventType: 'billing.invoice.payment_applied.v1', aggregateType: 'invoice', aggregateId: invoice.id, payload: { paymentId: payment.id, invoiceId: invoice.id, amount: allocation.amount.toFixed(), status }, headers: {} } });
    }

    if (!verified.surplus.isZero()) {
      const wallet = await this.lockOrCreateWallet(tx, input.projectId, input.apartmentId, input.currencyCode);
      const nextBalance = asDecimal(wallet.balance).plus(verified.surplus);
      await tx.apartmentWallet.update({ where: { id: wallet.id }, data: { balance: nextBalance.toFixed(12), version: { increment: 1 } } });
      await tx.walletEntry.create({ data: { walletId: wallet.id, paymentId: payment.id, type: 'PAYMENT_SURPLUS', amount: verified.surplus.toFixed(12), balanceAfter: nextBalance.toFixed(12), description: 'Payment surplus' } });
    }

    const codes = Array.from(new Set(input.ledger.lines.map((line) => line.accountCode)));
    const accounts = await tx.ledgerAccount.findMany({ where: { projectId: input.projectId, currencyCode: input.currencyCode, code: { in: codes }, isActive: true } });
    const accountIds = new Map(accounts.map((account) => [account.code, account.id]));
    if (accountIds.size !== codes.length) throw new Error('Ledger account is missing');
    const ledger = await tx.ledgerTransaction.create({ data: { projectId: input.projectId, referenceType: input.ledger.referenceType, referenceId: input.ledger.referenceId, description: input.ledger.description } });
    await tx.ledgerEntry.createMany({ data: input.ledger.lines.map((line) => ({ transactionId: ledger.id, accountId: accountIds.get(line.accountCode)!, side: line.side, amount: line.amount.toFixed(12), currencyCode: line.currencyCode, apartmentId: line.apartmentId, description: line.description })) });
    await tx.outboxEvent.create({ data: { eventId: payment.id + ':payment-applied', projectId: input.projectId, topic: 'qhome.billing.events.v1', eventType: 'billing.payment.applied.v1', aggregateType: 'payment', aggregateId: payment.id, payload: { paymentId: payment.id, appliedAmount: verified.appliedAmount.toFixed(), surplusAmount: verified.surplus.toFixed() }, headers: {} } });
    return { paymentId: payment.id, appliedAmount: verified.appliedAmount, surplusAmount: verified.surplus, invoiceIds: verified.allocations.map((allocation) => allocation.invoiceId) };
  }

  private async lockOrCreateWallet(tx: Tx, projectId: string, apartmentId: string, currencyCode: string) {
    const existing = await tx.apartmentWallet.findUnique({ where: { projectId_apartmentId_currencyCode: { projectId, apartmentId, currencyCode } } });
    if (existing) {
      await tx.$queryRawUnsafe('SELECT id FROM apartment_wallets WHERE id = $1::uuid FOR UPDATE', existing.id);
      return existing;
    }
    return tx.apartmentWallet.create({ data: { projectId, apartmentId, currencyCode, balance: '0' } });
  }

  async issueBatch(input: {
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
  }): Promise<{ invoiceIds: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const period = await tx.billingPeriod.findUnique({ where: { id: input.billingPeriodId } });
      if (!period || period.projectId !== input.projectId || !['OPEN', 'CALCULATING'].includes(period.status)) throw new Error('Billing period is not open for invoice issuance');
      const byApartment = new Map<string, typeof input.items>();
      for (const item of input.items) byApartment.set(item.apartmentId, [...(byApartment.get(item.apartmentId) ?? []), item]);
      const invoiceIds: string[] = [];
      for (const [apartmentId, items] of byApartment) {
        const first = items[0];
        const subtotal = items.reduce((sum, item) => sum.plus(item.netAmount), new Decimal(0));
        const vat = items.reduce((sum, item) => sum.plus(item.vatAmount), new Decimal(0));
        const total = items.reduce((sum, item) => sum.plus(item.totalAmount), new Decimal(0));
        const invoice = await tx.invoice.upsert({
          where: { billingPeriodId_apartmentId: { billingPeriodId: input.billingPeriodId, apartmentId } },
          create: { projectId: input.projectId, apartmentId, residentId: first.residentId, billingPeriodId: input.billingPeriodId, invoiceNumber: 'INV-' + input.billingPeriodId + '-' + apartmentId, status: 'ISSUED', currencyCode: first.currencyCode, subtotal: subtotal.toFixed(12), vatAmount: vat.toFixed(12), totalAmount: total.toFixed(12), dueAt: period.periodEnd, issuedAt: new Date() },
          update: { subtotal: subtotal.toFixed(12), vatAmount: vat.toFixed(12), totalAmount: total.toFixed(12), status: 'ISSUED', issuedAt: new Date(), version: { increment: 1 } },
        });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
        await tx.invoiceItem.createMany({ data: items.map((item) => ({ invoiceId: invoice.id, serviceId: item.serviceId, description: item.description, quantity: item.quantity.toFixed(12), unitPrice: item.unitPrice.toFixed(12), netAmount: item.netAmount.toFixed(12), vatAmount: item.vatAmount.toFixed(12), totalAmount: item.totalAmount.toFixed(12), currencyCode: item.currencyCode, pricingSnapshot: item.pricingSnapshot as Prisma.InputJsonValue })) });
        await tx.outboxEvent.create({ data: { eventId: invoice.id + ':issued:' + invoice.version, projectId: input.projectId, topic: 'qhome.billing.events.v1', eventType: 'billing.invoice.issued.v1', aggregateType: 'invoice', aggregateId: invoice.id, payload: { invoiceId: invoice.id, apartmentId, billingPeriodId: input.billingPeriodId, totalAmount: total.toFixed() }, headers: {} } });
        invoiceIds.push(invoice.id);
      }
      return { invoiceIds };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
  }

  async findOutstandingInvoices(projectId: string, apartmentIds: string[], cursor?: string, limit = 100) {
    const rows = await this.prisma.invoice.findMany({ where: { projectId, apartmentId: { in: apartmentIds }, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: 'asc' } });
    const visible = rows.length > limit ? rows.slice(0, limit) : rows;
    return { items: visible.map((row) => ({ id: row.id, projectId: row.projectId, apartmentId: row.apartmentId, currencyCode: row.currencyCode, totalAmount: asDecimal(row.totalAmount), paidAmount: asDecimal(row.paidAmount), status: row.status as InvoiceSnapshot['status'] })), nextCursor: rows.length > limit ? visible.at(-1)?.id : undefined };
  }

  async getConsumptionHistory(projectId: string, apartmentId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ period_start: Date; period_end: Date; electricity: Prisma.Decimal; water: Prisma.Decimal }>>(
      `SELECT bp.period_start, bp.period_end, COALESCE(SUM(CASE WHEN ii.description ILIKE '%electric%' THEN ii.quantity ELSE 0 END), 0) AS electricity, COALESCE(SUM(CASE WHEN ii.description ILIKE '%water%' THEN ii.quantity ELSE 0 END), 0) AS water FROM invoices i JOIN billing_periods bp ON bp.id = i.billing_period_id JOIN invoice_items ii ON ii.invoice_id = i.id WHERE i.project_id = $1::uuid AND i.apartment_id = $2::uuid AND bp.period_start >= $3 AND bp.period_end <= $4 GROUP BY bp.period_start, bp.period_end ORDER BY bp.period_start`,
      projectId,
      apartmentId,
      from,
      to,
    );
    return rows.map((row) => ({ periodStart: row.period_start, periodEnd: row.period_end, electricity: asDecimal(row.electricity), water: asDecimal(row.water) }));
  }

  async createBillingBatchJob(input: { projectId: string; billingPeriodId: string }) {
    const job = await this.prisma.billingBatchJob.upsert({ where: { billingPeriodId_projectId: input }, create: input, update: {} });
    return job.id;
  }

  async getAccountId(projectId: string, accountCode: string, currencyCode: string) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { projectId_code: { projectId, code: accountCode } } });
    if (!account || account.currencyCode !== currencyCode || !account.isActive) throw new Error('Ledger account ' + accountCode + ' is unavailable');
    return account.id;
  }

  async cashFlow(projectId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ code: string; debit: Prisma.Decimal; credit: Prisma.Decimal }>>(
      `SELECT la.code, COALESCE(SUM(CASE WHEN le.side = 'DEBIT' THEN le.amount ELSE 0 END), 0) AS debit, COALESCE(SUM(CASE WHEN le.side = 'CREDIT' THEN le.amount ELSE 0 END), 0) AS credit FROM ledger_entries le JOIN ledger_accounts la ON la.id = le.account_id JOIN ledger_transactions lt ON lt.id = le.transaction_id WHERE lt.project_id = $1::uuid AND lt.posted_at >= $2 AND lt.posted_at < $3 GROUP BY la.code ORDER BY la.code`,
      projectId,
      from,
      to,
    );
    return rows.map((row) => ({ accountCode: row.code, debit: asDecimal(row.debit), credit: asDecimal(row.credit), net: asDecimal(row.debit).minus(row.credit) }));
  }

  async receivables(projectId: string, asOf: Date) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ apartment_id: string; invoice_count: bigint; outstanding: Prisma.Decimal }>>(
      `SELECT apartment_id, COUNT(*) AS invoice_count, COALESCE(SUM(total_amount - paid_amount), 0) AS outstanding FROM invoices WHERE project_id = $1::uuid AND issued_at <= $2 AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') GROUP BY apartment_id ORDER BY outstanding DESC`,
      projectId,
      asOf,
    );
    return rows.map((row) => ({ apartmentId: row.apartment_id, invoiceCount: Number(row.invoice_count), outstanding: asDecimal(row.outstanding) }));
  }
}
