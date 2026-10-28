# billing-finance-service

Backend-only billing, double-entry finance, payment reconciliation and reporting service.

## Financial guarantees

- All money, quantity and balances are PostgreSQL `Decimal` and domain `decimal.js`; gRPC/HTTP exchange them as strings.
- Every payment is guarded by Redis idempotency and database unique constraints `(provider, providerTransactionId)` and `(provider, idempotencyKey)`.
- Payment settlement uses a Serializable transaction, invoice row locks, payment allocations, wallet surplus, double-entry ledger lines and outbox events in one commit.
- Partial payment leaves invoice `PARTIALLY_PAID`; overpayment credits `ApartmentWallet` and is available for later invoice allocation.
- Webhooks verify HMAC-SHA256 over `timestamp.rawBody`, reject timestamps outside the replay window, and use provider event uniqueness.
- Reports use aggregate SQL queries, not per-invoice loops. Batch billing pages apartment snapshots and queues invoice issue jobs with stable job IDs.

References: [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions), [PostgreSQL transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html), [PostgreSQL row locking](https://www.postgresql.org/docs/16/explicit-locking.html), [BullMQ](https://docs.bullmq.io/), and [Redis](https://redis.io/docs/latest/).
