import { BaseMicroservice } from '../../../libs/common/src/base-microservice';
import { ResidentMarketplaceModule } from './resident-marketplace.module';
import { verifyRequestContextProof } from '../../../libs/common/src/context-proof';

void BaseMicroservice.bootstrap({
  module: ResidentMarketplaceModule,
  serviceName: 'resident-marketplace-service',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',
  environment: process.env.NODE_ENV ?? 'production',
  httpPort: Number(process.env.RESIDENT_MARKETPLACE_HTTP_PORT ?? 3007),
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  verifyRequestContext: (context, transport, proof) => {
    verifyRequestContextProof(process.env.QHOME_CONTEXT_HMAC_SECRET ?? '', context, proof, transport);
    if (!context.tenantId || !context.correlationId || !context.apartmentId || !context.buildingId) throw new Error('tenant, building, apartment, and correlation context are required');
  },
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
