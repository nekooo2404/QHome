import Decimal from 'decimal.js';
import { InvoiceIssueRepository } from './ports';

interface InvoiceIssueItem {
  apartmentId: string;
  residentId?: string;
  serviceId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  netAmount: string;
  vatAmount: string;
  totalAmount: string;
  currencyCode: string;
  pricingSnapshot: Record<string, unknown>;
}

export class InvoiceIssueWorker {
  constructor(private readonly repository: InvoiceIssueRepository) {}

  process(data: { projectId: string; billingPeriodId: string; items: InvoiceIssueItem[] }) {
    return this.repository.issueBatch({
      projectId: data.projectId,
      billingPeriodId: data.billingPeriodId,
      items: data.items.map((item) => ({ ...item, quantity: new Decimal(item.quantity), unitPrice: new Decimal(item.unitPrice), netAmount: new Decimal(item.netAmount), vatAmount: new Decimal(item.vatAmount), totalAmount: new Decimal(item.totalAmount) })),
    });
  }
}
