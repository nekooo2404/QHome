import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { CardLifecycleServiceImpl } from '../../application/card-lifecycle.service';

interface DebtOverdueEvent {
  eventId: string;
  projectId: string;
  residentId: string;
  attempt?: number;
}

@Controller()
export class CardDebtKafkaController {
  constructor(private readonly cards: CardLifecycleServiceImpl) {}

  @EventPattern('finance.debt.overdue.v1')
  async handleDebtOverdue(@Payload() event: DebtOverdueEvent): Promise<void> {
    await this.cards.handleDebtOverdueWithRetry(event, event.attempt ?? 1);
  }

  @EventPattern('qhome.service-catalog.card-debt-retry.v1')
  async handleRetry(@Payload() event: DebtOverdueEvent): Promise<void> {
    await this.cards.handleDebtOverdueWithRetry(event, event.attempt ?? 1);
  }
}
