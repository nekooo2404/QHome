import { CardLifecycleService, CardRepository, InboxRepository, RetryPublisher, SmartCardRecord } from './ports';

export class CardLifecycleServiceImpl implements CardLifecycleService {
  constructor(
    private readonly repository: CardRepository,
    private readonly inbox: InboxRepository,
    private readonly retryPublisher: RetryPublisher,
    private readonly maxAttempts = 5,
  ) {}

  issue(input: Parameters<CardRepository['issue']>[0]): Promise<SmartCardRecord> {
    return this.repository.issue(input);
  }

  block(cardId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<SmartCardRecord> {
    return this.repository.block(cardId, reason);
  }

  unblock(cardId: string): Promise<SmartCardRecord> {
    return this.repository.unblock(cardId);
  }

  revoke(cardId: string): Promise<SmartCardRecord> {
    return this.repository.revoke(cardId);
  }

  async handleDebtOverdue(event: { eventId: string; projectId: string; residentId: string }): Promise<number> {
    const result = await this.inbox.processOnce({
      eventId: event.eventId,
      eventType: 'finance.debt.overdue.v1',
      handler: () => this.repository.blockActiveCardsByResident(event.projectId, event.residentId, 'OVERDUE_DEBT'),
    });
    return result.processed ? result.result ?? 0 : 0;
  }

  async handleDebtOverdueWithRetry(event: { eventId: string; projectId: string; residentId: string }, attempt = 1): Promise<void> {
    try {
      await this.handleDebtOverdue(event);
    } catch (error) {
      if (attempt < this.maxAttempts) {
        const delayMs = 2 ** Math.min(attempt, 10) * 1000;
        await this.retryPublisher.publishRetry({ eventId: event.eventId, eventType: 'finance.debt.overdue.v1', payload: event, attempt: attempt + 1, availableAt: new Date(Date.now() + delayMs) });
        return;
      }
      await this.retryPublisher.publishDlq({ eventId: event.eventId, eventType: 'finance.debt.overdue.v1', payload: event, attempts: attempt, error: error instanceof Error ? error.message : 'card block failed' });
    }
  }
}
