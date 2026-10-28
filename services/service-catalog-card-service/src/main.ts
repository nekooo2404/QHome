import { BaseMicroservice } from '../../../libs/common/src/base-microservice';
import { ServiceCatalogCardModule } from './service-catalog-card.module';

void BaseMicroservice.bootstrap({
  module: ServiceCatalogCardModule,
  serviceName: 'service-catalog-card-service',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',
  environment: process.env.NODE_ENV ?? 'production',
  httpPort: Number(process.env.SERVICE_CATALOG_HTTP_PORT ?? 3003),
  grpc: { package: 'qhome.service.catalog.card.v1', protoPath: '../../../proto/service_catalog_card.proto', url: process.env.SERVICE_CATALOG_GRPC_URL ?? '0.0.0.0:50053', includeDirs: ['../../../proto'] },
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  verifyRequestContext: (context, transport, proof) => {
    if (!proof || proof.length < 32) throw new Error(`authenticated context proof is required for ${transport}`);
    if (!context.tenantId || !context.correlationId) throw new Error('tenant and correlation context are required');
  },
}).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
