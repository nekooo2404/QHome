import { BaseMicroservice } from '../../../libs/common/src/base-microservice';
import { BillingFinanceModule } from './billing-finance.module';
import { verifyRequestContextProof } from '../../../libs/common/src/context-proof';

void BaseMicroservice.bootstrap({
  module: BillingFinanceModule,
  serviceName: 'billing-finance-service',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',
  environment: process.env.NODE_ENV ?? 'production',
  httpPort: Number(process.env.BILLING_FINANCE_HTTP_PORT ?? 3004),
  grpc: {
    package: 'qhome.billing.finance.v1',
    protoPath: '../../../proto/billing_finance_marketplace.proto',
    url: process.env.BILLING_FINANCE_GRPC_URL ?? '0.0.0.0:50054',
    includeDirs: ['../../../proto'],
  },
  rawBody: true,
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  verifyRequestContext: (context, transport, proof) => {
    verifyRequestContextProof(process.env.QHOME_CONTEXT_HMAC_SECRET ?? '', context, proof, transport);
    if (!context.tenantId || !context.correlationId) throw new Error('tenant and correlation context are required');
  },
}).catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n'); process.exitCode = 1; });
