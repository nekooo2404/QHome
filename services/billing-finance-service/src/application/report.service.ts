import { ReportRepository } from './ports';

export class ReportService {
  constructor(private readonly repository: ReportRepository) {}

  cashFlow(projectId: string, from: Date, to: Date) {
    if (to < from) throw new Error('Report range is invalid');
    return this.repository.cashFlow(projectId, from, to);
  }

  receivables(projectId: string, asOf: Date) {
    return this.repository.receivables(projectId, asOf);
  }
}
