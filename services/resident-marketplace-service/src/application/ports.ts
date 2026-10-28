import { OrderTransition, ServiceOrderStatus } from '../domain/order.state-machine';

export interface MarketplaceContext {
  projectId: string;
  buildingId: string;
  apartmentId: string;
  residentId: string;
  actorId: string;
  correlationId: string;
}

export type OrderItemInput = {
  productId?: string;
  serviceCatalogId?: string;
  quantity: number;
};

export interface CreateOrderInput extends MarketplaceContext {
  type: 'INTERNAL_SHOP' | 'HOME_SERVICE';
  idempotencyKey: string;
  requestHash: string;
  currencyCode: string;
  items: OrderItemInput[];
  scheduledStart?: Date;
  scheduledEnd?: Date;
  addressSnapshot: Record<string, unknown>;
  notes?: string;
}

export interface CatalogShop {
  id: string;
  projectId: string;
  buildingId?: string;
  partnerId?: string;
  name: string;
  slug: string;
  description?: string;
  status: string;
  opensAt?: string;
  closesAt?: string;
  metadata: Record<string, unknown>;
}

export interface CatalogProduct {
  id: string;
  shopId: string;
  sku: string;
  name: string;
  description?: string;
  currencyCode: string;
  priceMinorUnits: string;
  status: string;
  availableQuantity: number;
  metadata: Record<string, unknown>;
}

export interface HomeServiceCatalogItem {
  id: string;
  projectId: string;
  partnerId?: string;
  code: string;
  name: string;
  category: string;
  description?: string;
  currencyCode: string;
  basePriceMinorUnits: string;
  durationMinutes: number;
  requiresTechnician: boolean;
  status: string;
  metadata: Record<string, unknown>;
}

export interface UtilityContractSnapshot {
  id: string;
  serviceType: string;
  providerName: string;
  contractNumber: string;
  status: string;
  connectionStatus: string;
  accountReference: string;
  startsAt: Date;
  endsAt?: Date;
  connectedAt?: Date;
}

export interface OrderSnapshot {
  id: string;
  projectId: string;
  apartmentId: string;
  residentId: string;
  type: 'INTERNAL_SHOP' | 'HOME_SERVICE';
  status: ServiceOrderStatus;
  shopId?: string;
  shopPartnerId?: string;
  serviceCatalogId?: string;
  serviceCategory?: string;
  servicePartnerId?: string;
  requiresTechnician: boolean;
  requiredSkills: string[];
  currencyCode: string;
  subtotalMinorUnits: string;
  serviceFeeMinorUnits: string;
  totalMinorUnits: string;
  scheduledStart?: Date;
  scheduledEnd?: Date;
  addressSnapshot: Record<string, unknown>;
  notes?: string;
  paymentIntentId?: string;
  idempotencyKey: string;
  version: number;
  paidAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  refundedAt?: Date;
  cancellationReason?: string;
  items: Array<{
    id: string;
    productId?: string;
    serviceCatalogId?: string;
    description: string;
    sku?: string;
    quantity: number;
    unitPriceMinorUnits: string;
    totalMinorUnits: string;
  }>;
  assignments: Array<{
    id: string;
    partnerId: string;
    technicianId?: string;
    type: 'SHOP_PARTNER' | 'TECHNICIAN';
    status: string;
  }>;
}

export interface TechnicianCandidate {
  id: string;
  partnerId: string;
  score: number;
  currentLoad: number;
  maxConcurrentJobs: number;
}

export interface MarketplaceRepository {
  createOrder(input: CreateOrderInput): Promise<OrderSnapshot>;
  getOrder(projectId: string, apartmentId: string | undefined, orderId: string): Promise<OrderSnapshot | null>;
  listOrders(projectId: string, apartmentId: string, take: number, cursor?: string): Promise<{ items: OrderSnapshot[]; nextCursor?: string }>;
  findOrdersNeedingCompensation(now: Date, take: number): Promise<OrderSnapshot[]>;
  transitionOrder(input: {
    projectId: string;
    orderId: string;
    expectedVersion: number;
    nextStatus: ServiceOrderStatus;
    actorId: string;
    reason?: string;
    correlationId: string;
  }): Promise<OrderSnapshot>;
  setPaymentIntent(input: { projectId: string; orderId: string; paymentIntentId: string; expectedVersion: number }): Promise<OrderSnapshot>;
  assignOrder(input: {
    projectId: string;
    orderId: string;
    expectedVersion: number;
    actorId: string;
    correlationId: string;
    partnerId: string;
    technicianId?: string;
    score?: number;
  }): Promise<OrderSnapshot>;
  findTechnicianCandidates(input: { projectId: string; buildingId: string; skills: string[]; startsAt: Date; endsAt: Date }): Promise<TechnicianCandidate[]>;
  listShops(projectId: string, buildingId: string): Promise<CatalogShop[]>;
  listProducts(projectId: string, buildingId: string, shopId: string): Promise<CatalogProduct[]>;
  listHomeServices(projectId: string, buildingId: string, category?: string): Promise<HomeServiceCatalogItem[]>;
  listUtilityContracts(projectId: string, apartmentId: string): Promise<UtilityContractSnapshot[]>;
  requestUtilityConnection(input: { projectId: string; apartmentId: string; contractId: string; actorId: string; correlationId: string }): Promise<UtilityContractSnapshot>;
  updateSaga(input: { projectId: string; orderId: string; status: string; currentStep: string; paymentIntentId?: string; refundId?: string; lastError?: string; nextAttemptAt?: Date }): Promise<void>;
  beginInboxMessage(eventId: string, eventType: string): Promise<boolean>;
  completeInboxMessage(eventId: string): Promise<void>;
  failInboxMessage(eventId: string, error: string): Promise<void>;
}

export interface BillingFinanceClient {
  createPaymentIntent(input: {
    projectId: string;
    buildingId: string;
    apartmentId: string;
    residentId: string;
    orderId: string;
    amountMinorUnits: string;
    currencyCode: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<{ paymentIntentId: string; status: string; provider: string }>;
  requestRefund(input: {
    projectId: string;
    buildingId: string;
    apartmentId: string;
    residentId: string;
    orderId: string;
    paymentIntentId: string;
    amountMinorUnits: string;
    currencyCode: string;
    idempotencyKey: string;
    correlationId: string;
    reason: string;
  }): Promise<{ refundId: string; status: string }>;
}

export interface MarketplaceCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export interface KafkaProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown>; headers?: Record<string, string> }): Promise<void>;
  close?(): Promise<void>;
}

export interface BillingPaymentEvent {
  eventId: string;
  eventType: string;
  projectId: string;
  orderId: string;
  paymentIntentId: string;
  refundId?: string;
  amountMinorUnits?: string;
  currencyCode?: string;
  occurredAt?: string;
  correlationId?: string;
}

export interface OrderTransitionPublisher {
  publish(transition: OrderTransition): Promise<void>;
}
