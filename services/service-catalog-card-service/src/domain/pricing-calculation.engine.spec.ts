import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import { PricingCalculationEngine } from './pricing-calculation.engine';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('PricingCalculationEngine', () => {
  const engine = new PricingCalculationEngine();

  it('calculates progressive tiers with VAT and environmental fee using Decimal', () => {
    const result = engine.calculate({
      id: 'electricity-v1', formulaType: 'TIERED', baseAmount: new Decimal('0'), unitPrice: new Decimal('0'), includedQty: new Decimal('0'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), currencyCode: 'VND', roundingScale: 2,
      tiers: [
        { lowerBound: new Decimal('0'), upperBound: new Decimal('100'), unitPrice: new Decimal('1'), fixedCharge: new Decimal('0'), vatRate: new Decimal('0.1'), environmentalFeeRate: new Decimal('0.05'), sequence: 1 },
        { lowerBound: new Decimal('100'), upperBound: null, unitPrice: new Decimal('2'), fixedCharge: new Decimal('0'), vatRate: new Decimal('0.1'), environmentalFeeRate: new Decimal('0.05'), sequence: 2 },
      ],
    }, { quantity: new Decimal('150'), periodStart: date('2026-01-01'), periodEnd: date('2026-01-31') });
    assert.equal(result.netAmount.toFixed(2), '200.00');
    assert.equal(result.vatAmount.toFixed(2), '20.00');
    assert.equal(result.environmentalFee.toFixed(2), '10.00');
    assert.equal(result.totalAmount.toFixed(2), '230.00');
  });

  it('prorates a fixed charge by inclusive calendar days', () => {
    const result = engine.calculate({ id: 'management', formulaType: 'PRORATED', baseAmount: new Decimal('310'), unitPrice: new Decimal('0'), includedQty: new Decimal('0'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), currencyCode: 'VND', roundingScale: 2, tiers: [] }, { quantity: new Decimal('0'), periodStart: date('2026-01-01'), periodEnd: date('2026-01-31'), serviceStart: date('2026-01-17') });
    assert.equal(result.totalAmount.toFixed(2), '150.00');
  });

  it('charges only vehicles outside the parking quota', () => {
    const result = engine.calculate({ id: 'parking', formulaType: 'PARKING_QUOTA', baseAmount: new Decimal('100'), unitPrice: new Decimal('20'), includedQty: new Decimal('1'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), currencyCode: 'VND', roundingScale: 2, tiers: [] }, { vehicleCount: new Decimal('3'), periodStart: date('2026-01-01'), periodEnd: date('2026-01-31') });
    assert.equal(result.totalAmount.toFixed(2), '140.00');
  });

  it('counts Vietnamese calendar days correctly across a UTC boundary', () => {
    const result = engine.calculate({ id: 'management-october', formulaType: 'PRORATED', baseAmount: new Decimal('310'), unitPrice: new Decimal('0'), includedQty: new Decimal('0'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), currencyCode: 'VND', roundingScale: 2, tiers: [] }, { quantity: new Decimal('0'), periodStart: new Date('2026-09-30T17:00:00.000Z'), periodEnd: new Date('2026-10-31T16:59:59.999Z'), serviceStart: new Date('2026-09-30T17:00:00.000Z'), serviceEnd: new Date('2026-10-31T16:59:59.999Z') });
    assert.equal(result.totalAmount.toFixed(2), '310.00');
  });

  it('does not prorate meter-based tiered consumption', () => {
    const result = engine.calculate({ id: 'water-tiered', formulaType: 'TIERED', baseAmount: new Decimal('0'), unitPrice: new Decimal('0'), includedQty: new Decimal('0'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), currencyCode: 'VND', roundingScale: 2, tiers: [{ lowerBound: new Decimal('0'), upperBound: new Decimal('100'), unitPrice: new Decimal('10'), fixedCharge: new Decimal('0'), vatRate: new Decimal('0'), environmentalFeeRate: new Decimal('0'), sequence: 1 }] }, { quantity: new Decimal('50'), periodStart: new Date('2026-10-01T00:00:00+07:00'), periodEnd: new Date('2026-10-31T23:59:59+07:00'), serviceStart: new Date('2026-10-16T00:00:00+07:00') });
    assert.equal(result.totalAmount.toFixed(2), '500.00');
  });
});
