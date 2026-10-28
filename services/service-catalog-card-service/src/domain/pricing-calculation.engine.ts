import Decimal from 'decimal.js';
import {
  assertNonNegative,
  assertRate,
  PricingCalculationContext,
  PricingCalculationResult,
  PricingPlanSnapshot,
  PricingTierSnapshot,
} from './pricing.types';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const MS_PER_DAY = 86_400_000;

export class PricingCalculationEngine {
  calculate(plan: PricingPlanSnapshot, context: PricingCalculationContext): PricingCalculationResult {
    this.validatePlan(plan);
    this.validateContext(context);
    const base = this.calculateBeforeProration(plan, context);
    const prorate = this.prorationFactor(context);
    const net = base.net.times(prorate);
    const vat = base.vat.times(prorate);
    const environmentalFee = base.environmental.times(prorate);
    const roundedNet = this.round(net, plan.roundingScale);
    const roundedVat = this.round(vat, plan.roundingScale);
    const roundedEnvironmental = this.round(environmentalFee, plan.roundingScale);
    return {
      netAmount: roundedNet,
      vatAmount: roundedVat,
      environmentalFee: roundedEnvironmental,
      totalAmount: this.round(roundedNet.plus(roundedVat).plus(roundedEnvironmental), plan.roundingScale),
      currencyCode: plan.currencyCode,
      roundingScale: plan.roundingScale,
    };
  }

  private calculateBeforeProration(plan: PricingPlanSnapshot, context: PricingCalculationContext): { net: Decimal; vat: Decimal; environmental: Decimal } {
    switch (plan.formulaType) {
      case 'FIXED':
        return this.tax(plan.baseAmount, plan.vatRate, plan.environmentalFeeRate);
      case 'AREA':
        return this.tax(plan.unitPrice.times(this.required(context.areaSqm, 'areaSqm')), plan.vatRate, plan.environmentalFeeRate);
      case 'HEADCOUNT':
        return this.tax(plan.unitPrice.times(this.required(context.headcount, 'headcount')), plan.vatRate, plan.environmentalFeeRate);
      case 'VEHICLE_COUNT':
        return this.tax(plan.baseAmount.plus(plan.unitPrice.times(this.required(context.vehicleCount, 'vehicleCount'))), plan.vatRate, plan.environmentalFeeRate);
      case 'PARKING_QUOTA':
        return this.tax(plan.baseAmount.plus(plan.unitPrice.times(this.required(context.vehicleCount, 'vehicleCount').minus(plan.includedQty).greaterThan(0) ? this.required(context.vehicleCount, 'vehicleCount').minus(plan.includedQty) : ZERO)), plan.vatRate, plan.environmentalFeeRate);
      case 'TIERED':
        return this.calculateTiers(plan.tiers, this.required(context.quantity, 'quantity'));
      case 'PRORATED':
        return this.tax(plan.baseAmount.plus(plan.unitPrice.times(this.required(context.quantity, 'quantity'))), plan.vatRate, plan.environmentalFeeRate);
      default:
        throw new Error(`Unsupported pricing formula: ${String(plan.formulaType)}`);
    }
  }

  private calculateTiers(tiers: PricingTierSnapshot[], quantity: Decimal): { net: Decimal; vat: Decimal; environmental: Decimal } {
    if (tiers.length === 0) throw new Error('Tiered pricing requires at least one tier');
    let net = ZERO;
    let vat = ZERO;
    let environmental = ZERO;
    for (const tier of [...tiers].sort((a, b) => a.sequence - b.sequence)) {
      const upper = tier.upperBound ?? quantity;
      if (quantity.lessThanOrEqualTo(tier.lowerBound)) continue;
      const consumed = Decimal.min(quantity, upper).minus(tier.lowerBound);
      if (consumed.isNegative()) continue;
      const tierNet = tier.fixedCharge.plus(consumed.times(tier.unitPrice));
      const taxed = this.tax(tierNet, tier.vatRate, tier.environmentalFeeRate);
      net = net.plus(taxed.net);
      vat = vat.plus(taxed.vat);
      environmental = environmental.plus(taxed.environmental);
    }
    return { net, vat, environmental };
  }

  private prorationFactor(context: PricingCalculationContext): Decimal {
    if (!context.serviceStart && !context.serviceEnd) return ONE;
    const periodDays = this.dayCount(context.periodStart, context.periodEnd);
    const activeStart = context.serviceStart && context.serviceStart > context.periodStart ? context.serviceStart : context.periodStart;
    const activeEnd = context.serviceEnd && context.serviceEnd < context.periodEnd ? context.serviceEnd : context.periodEnd;
    if (activeEnd < activeStart) return ZERO;
    return this.dayCount(activeStart, activeEnd).div(periodDays);
  }

  private dayCount(start: Date, end: Date): Decimal {
    const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    const days = Math.floor((endUtc - startUtc) / MS_PER_DAY) + 1;
    if (days <= 0) throw new Error('Date range must be positive');
    return new Decimal(String(days));
  }

  private tax(net: Decimal, vatRate: Decimal, environmentalFeeRate: Decimal) {
    return { net, vat: net.times(vatRate), environmental: net.times(environmentalFeeRate) };
  }

  private required(value: Decimal | undefined, name: string): Decimal {
    if (!value) throw new Error(`${name} is required`);
    assertNonNegative(value, name);
    return value;
  }

  private round(value: Decimal, scale: number): Decimal {
    return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  }

  private validatePlan(plan: PricingPlanSnapshot): void {
    if (!plan.id || !plan.currencyCode || !Number.isInteger(plan.roundingScale) || plan.roundingScale < 0 || plan.roundingScale > 12) throw new Error('Invalid pricing plan metadata');
    [plan.baseAmount, plan.unitPrice, plan.includedQty].forEach((value, index) => assertNonNegative(value, `plan monetary field ${index}`));
    assertRate(plan.vatRate, 'vatRate');
    assertRate(plan.environmentalFeeRate, 'environmentalFeeRate');
    for (const tier of plan.tiers) {
      assertNonNegative(tier.lowerBound, 'tier.lowerBound');
      assertNonNegative(tier.unitPrice, 'tier.unitPrice');
      assertNonNegative(tier.fixedCharge, 'tier.fixedCharge');
      assertRate(tier.vatRate, 'tier.vatRate');
      assertRate(tier.environmentalFeeRate, 'tier.environmentalFeeRate');
      if (tier.upperBound && tier.upperBound.lessThanOrEqualTo(tier.lowerBound)) throw new Error('Tier upperBound must exceed lowerBound');
    }
  }

  private validateContext(context: PricingCalculationContext): void {
    if (!(context.periodStart instanceof Date) || !(context.periodEnd instanceof Date) || context.periodEnd < context.periodStart) throw new Error('Invalid billing period');
  }
}
