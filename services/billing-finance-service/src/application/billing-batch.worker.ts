import Decimal from 'decimal.js';
import { ApartmentSnapshotClient, PricingBatchClient, QueueLike } from './ports';

export interface BillingBatchJobData {
  projectId: string;
  billingPeriodId: string;
  pricingPlanId: string;
}

export class BillingBatchWorker {
  constructor(
    private readonly jobs: QueueLike,
    private readonly apartments: ApartmentSnapshotClient,
    private readonly pricing: PricingBatchClient,
    private readonly pageSize = 500,
  ) {}

  async run(job: BillingBatchJobData): Promise<{ queued: number }> {
    let cursor: string | undefined;
    let queued = 0;
    do {
      const page = await this.apartments.listBillableApartments(job.projectId, job.billingPeriodId, cursor, this.pageSize);
      if (page.items.length === 0) break;
      const results = await this.pricing.calculateBatch(page.items.map((apartment) => ({ apartmentId: apartment.apartmentId, pricingPlanId: job.pricingPlanId, quantity: new Decimal('1'), context: { areaSqm: apartment.areaSqm.toFixed(), headcount: apartment.headcount.toFixed(), vehicleCount: apartment.vehicleCount.toFixed(), billingPeriodId: job.billingPeriodId } })));
      await this.jobs.add('billing.issue-invoices', { projectId: job.projectId, billingPeriodId: job.billingPeriodId, items: results.map((result) => ({ ...result, quantity: result.quantity.toFixed(), unitPrice: result.unitPrice.toFixed(), netAmount: result.netAmount.toFixed(), vatAmount: result.vatAmount.toFixed(), totalAmount: result.totalAmount.toFixed() })) }, { jobId: `issue:${job.billingPeriodId}:${page.items[0].apartmentId}:${cursor ?? 'first'}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 } });
      queued += results.length;
      cursor = page.nextCursor;
    } while (cursor);
    return { queued };
  }
}
