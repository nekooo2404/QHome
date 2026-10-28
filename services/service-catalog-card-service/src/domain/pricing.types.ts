import Decimal from 'decimal.js';

export type DecimalValue = Decimal | string;
export type PricingFormulaType = 'FIXED' | 'AREA' | 'HEADCOUNT' | 'VEHICLE_COUNT' | 'TIERED' | 'PRORATED' | 'PARKING_QUOTA';

export interface PricingTierSnapshot {
  lowerBound: Decimal;
  upperBound: Decimal | null;
  unitPrice: Decimal;
  fixedCharge: Decimal;
  vatRate: Decimal;
  environmentalFeeRate: Decimal;
  sequence: number;
}

export interface PricingPlanSnapshot {
  id: string;
  formulaType: PricingFormulaType;
  baseAmount: Decimal;
  unitPrice: Decimal;
  includedQty: Decimal;
  vatRate: Decimal;
  environmentalFeeRate: Decimal;
  currencyCode: string;
  roundingScale: number;
  tiers: PricingTierSnapshot[];
}

export interface PricingCalculationContext {
  quantity?: Decimal;
  areaSqm?: Decimal;
  headcount?: Decimal;
  vehicleCount?: Decimal;
  periodStart: Date;
  periodEnd: Date;
  serviceStart?: Date;
  serviceEnd?: Date;
}

export interface PricingCalculationResult {
  netAmount: Decimal;
  vatAmount: Decimal;
  environmentalFee: Decimal;
  totalAmount: Decimal;
  currencyCode: string;
  roundingScale: number;
}

export function decimal(value: DecimalValue): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function assertNonNegative(value: Decimal, name: string): void {
  if (!value.isFinite() || value.isNegative()) throw new Error(`${name} must be a finite non-negative Decimal`);
}

export function assertRate(value: Decimal, name: string): void {
  assertNonNegative(value, name);
  if (value.greaterThan(1)) throw new Error(`${name} must be between 0 and 1`);
}
