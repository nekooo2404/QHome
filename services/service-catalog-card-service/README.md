# service-catalog-card-service

Backend-only pricing, service-contract and smart-card lifecycle service.

## Monetary invariants

- PostgreSQL monetary, quantity, rate, area and tier-bound fields use `Decimal` columns.
- Domain calculations use `decimal.js`; no JavaScript `number` enters a currency, utility-consumption or area calculation.
- gRPC accepts and returns Decimal values as strings.
- The only `number` values in the pricing domain are technical metadata: tier sequence and rounding scale.
- Rounding happens once at the result boundary with `ROUND_HALF_UP`; intermediate tier/tax/proration values remain arbitrary precision.

## Pricing engine

`PricingCalculationEngine` is a stateless pure domain service. It supports fixed, area, headcount, vehicle count, parking quota, progressive tiers, VAT, environmental fee and inclusive-calendar-day proration. A batch caller can load one immutable pricing snapshot and evaluate thousands of apartments without N+1 queries.

## Cards and Kafka

Card mutations and debt-triggered blocks are persisted with outbox events. Finance debt events are deduplicated through `InboxMessage`; failures are retried with bounded exponential backoff and then sent to a DLQ. Card blocking is idempotent because only `ACTIVE` cards are transitioned to `BLOCKED`.

References: [decimal.js](https://mikemcl.github.io/decimal.js/), [Prisma Decimal and transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions), [NestJS gRPC](https://docs.nestjs.com/microservices/grpc), [KafkaJS](https://kafka.js.org/docs/producing), and [PostgreSQL numeric types](https://www.postgresql.org/docs/16/datatype-numeric.html).
