# property-resident-service

Backend-only property, apartment, resident, vehicle and building contact service.

## Guarantees

- `ApartmentResidentMap` is the source of truth for many-to-many resident/apartment membership. A resident can be active in multiple projects and apartments simultaneously.
- `ActiveApartmentContext` is scoped by `(residentId, projectId)`; switching one project does not change the active apartment in another project.
- Read paths use replica Prisma client plus Redis cache-aside. Cache keys use a project hash tag so keys for one project are co-located in Redis Cluster.
- Mutations write the aggregate and a Kafka transactional-outbox row in the same PostgreSQL transaction. The outbox relay uses leases and idempotent Kafka producer settings; consumers must still be idempotent.
- Excel imports use Multer disk storage followed by an ExcelJS `WorkbookReader`. Rows are accumulated only up to `PROPERTY_RESIDENT_IMPORT_BATCH_SIZE` and each batch uses one short `createMany` transaction.
- `prisma/partitioning.sql` is the physical PostgreSQL partition contract for the append-only resident change log. Provision the next monthly partition before its first write.

## Import workbook

The multipart field is `file`. The first row of each worksheet is the header row.

Resident columns: `external_ref`, `user_id`, `full_name`, `phone`, `email`, `apartment_id`, `role`.

Vehicle columns: `external_ref`, `resident_external_ref`, `apartment_id`, `type`, `license_plate`, `registration_number`, `registration_object_ref`.

The importer rejects a vehicle whose resident/apartment mapping is not active in this project.

## Required runtime configuration

`PROPERTY_RESIDENT_DATABASE_URL`, `PROPERTY_RESIDENT_REPLICA_DATABASE_URL`, `PROPERTY_RESIDENT_REDIS_NODES`, `PROPERTY_RESIDENT_KAFKA_BROKERS`, `PROPERTY_RESIDENT_IMPORT_TMP_DIR`, and the corresponding TLS/authentication variables are supplied by deployment secrets/configuration. No secrets are stored in this repository.

The HTTP import route must be protected by the Gateway with a strict role, body-size, rate and concurrency policy. The service itself enforces tenant IDs and hierarchy checks.

Implementation references: [NestJS gRPC](https://docs.nestjs.com/microservices/grpc), [Prisma CRUD](https://www.prisma.io/docs/orm/prisma-client/queries/crud), [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions), [ExcelJS streaming XLSX](https://github.com/exceljs/exceljs#streaming-xlsx), and [PostgreSQL declarative partitioning](https://www.postgresql.org/docs/16/ddl-partitioning.html).
