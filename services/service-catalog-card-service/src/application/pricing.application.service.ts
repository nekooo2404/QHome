import { PricingCalculationEngine } from '../domain/pricing-calculation.engine';
import { PricingApplicationService, PricingPlanRepository, PricingCalculationRequest } from './ports';

export class PricingApplicationServiceImpl implements PricingApplicationService {
  constructor(
    private readonly repository: PricingPlanRepository,
    private readonly engine: PricingCalculationEngine,
  ) {}

  async calculate(request: PricingCalculationRequest) {
    const plan = await this.repository.getSnapshot(request.pricingPlanId, request.context.periodStart);
    return this.engine.calculate(plan, request.context);
  }
}
