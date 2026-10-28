import { BaseMicroservice } from '../../../libs/common/src/base-microservice';
import { BillingFinanceModule } from './billing-finance.module';

void BaseMicroservice.bootstrap({
  module: BillingFinanceModule,
  serviceName: 'billing-finance-service',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',
  environment: process.env.NODE_ENV ?? 'production',
  httpPort: Number(process.env.BILLING_FINANCE_HTTP_PORT ?? 3004),
  rawBody: true,
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  verifyRequestContext: (context, transport, proof) => {
    if (!proof || proof.length < 32) throw new Error('authenticated context proof is required for ' + transport);
    if (!context.tenantId || !context.correlationId) throw new Error('tenant and correlation context are required');
  },
}).catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n'); process.exitCode = 1; });
