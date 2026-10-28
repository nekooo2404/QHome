import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ImportBatch, ApartmentView, BuildingView, BuildingBlockView, ContactDirectoryView, FloorView, ResidentApartmentView, ResidentView, VehicleView } from '../../domain/models';
import { PropertyResidentRepository } from '../../application/ports';

type Tx = Prisma.TransactionClient;

function decimal(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function eventData(input: {
  projectId: string;
  buildingId?: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}) {
  return {
    eventId: randomUUID(),
    projectId: input.projectId,
    buildingId: input.buildingId,
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload as Prisma.InputJsonValue,
    headers: {} as Prisma.InputJsonValue,
    occurredAt: input.occurredAt ?? new Date(),
  };
}

function mapBuilding(value: { id: string; projectId: string; code: string; name: string; address: string | null; status: string; version: number }): BuildingView {
  return { ...value };
}

function mapApartment(value: { id: string; projectId: string; buildingId: string; blockId: string; floorId: string; code: string; netAreaSqm: unknown; grossAreaSqm: unknown; status: string; handoverStatus: 'NOT_READY' | 'SCHEDULED' | 'HANDED_OVER' | 'REJECTED'; handedOverAt: Date | null }): ApartmentView {
  return { ...value, netAreaSqm: decimal(value.netAreaSqm), grossAreaSqm: value.grossAreaSqm === null ? null : decimal(value.grossAreaSqm), handedOverAt: value.handedOverAt?.toISOString() ?? null };
}

function mapBlock(value: { id: string; buildingId: string; code: string; name: string; status: string }): BuildingBlockView { return { ...value }; }
function mapFloor(value: { id: string; blockId: string; floorNo: number; label: string }): FloorView { return { ...value }; }

function mapResident(value: { id: string; userId: string; externalRef: string; fullName: string; phone: string | null; email: string | null; status: string }): ResidentView {
  return { ...value };
}

function mapVehicle(value: { id: string; residentId: string; apartmentId: string; externalRef: string; type: string; licensePlate: string; registrationNumber: string | null; registrationObjectRef: string | null; status: string }): VehicleView {
  return { ...value, type: value.type as VehicleView['type'] };
}

export class PrismaPropertyResidentRepository implements PropertyResidentRepository {
  constructor(
    private readonly primary: PrismaClient,
    private readonly replica: PrismaClient,
  ) {}

  async createBuilding(input: { projectId: string; code: string; name: string; address?: string }): Promise<BuildingView> {
    return this.primary.$transaction(async (tx) => {
      const building = await tx.building.create({ data: input });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: building.id, eventType: 'property.building.created.v1', aggregateType: 'building', aggregateId: building.id, payload: { buildingId: building.id, code: building.code } }) });
      return mapBuilding(building);
    });
  }

  async listBuildings(projectId: string, take: number, cursor?: string): Promise<{ items: BuildingView[]; nextCursor?: string }> {
    const items = await this.replica.building.findMany({ where: { projectId }, take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: 'asc' } });
    const hasNext = items.length > take;
    const visible = hasNext ? items.slice(0, take) : items;
    return { items: visible.map(mapBuilding), nextCursor: hasNext ? visible.at(-1)?.id : undefined };
  }

  async getBuilding(projectId: string, buildingId: string): Promise<BuildingView | null> {
    const value = await this.replica.building.findFirst({ where: { id: buildingId, projectId } });
    return value ? mapBuilding(value) : null;
  }

  async updateBuilding(input: { projectId: string; buildingId: string; code?: string; name?: string; address?: string; status?: string; expectedVersion?: number }): Promise<BuildingView> {
    return this.primary.$transaction(async (tx) => {
      const building = await tx.building.findFirst({ where: { id: input.buildingId, projectId, ...(input.expectedVersion === undefined ? {} : { version: input.expectedVersion }) } });
      if (!building) throw new Error('Building not found or version conflict');
      const updated = await tx.building.update({ where: { id: building.id }, data: { code: input.code, name: input.name, address: input.address, status: input.status as 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | undefined, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: eventData({ projectId, buildingId: updated.id, eventType: 'property.building.updated.v1', aggregateType: 'building', aggregateId: updated.id, payload: { buildingId: updated.id, version: updated.version } }) });
      return mapBuilding(updated);
    });
  }

  async createBlock(input: { projectId: string; buildingId: string; code: string; name: string }): Promise<BuildingBlockView> {
    return this.primary.$transaction(async (tx) => {
      const building = await tx.building.findFirst({ where: { id: input.buildingId, projectId: input.projectId, status: 'ACTIVE' } });
      if (!building) throw new Error('Building is outside the project');
      const block = await tx.buildingBlock.create({ data: { buildingId: input.buildingId, code: input.code, name: input.name } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: input.buildingId, eventType: 'property.building_block.created.v1', aggregateType: 'building_block', aggregateId: block.id, payload: { blockId: block.id, buildingId: block.buildingId } }) });
      return mapBlock(block);
    });
  }

  async listBlocks(projectId: string, buildingId: string): Promise<BuildingBlockView[]> {
    const values = await this.replica.buildingBlock.findMany({ where: { buildingId, building: { projectId } }, orderBy: { code: 'asc' } });
    return values.map(mapBlock);
  }

  async createFloor(input: { projectId: string; blockId: string; floorNo: number; label: string }): Promise<FloorView> {
    return this.primary.$transaction(async (tx) => {
      const block = await tx.buildingBlock.findFirst({ where: { id: input.blockId, building: { projectId: input.projectId, status: 'ACTIVE' } } });
      if (!block) throw new Error('Building block is outside the project');
      const floor = await tx.floor.create({ data: { blockId: input.blockId, floorNo: input.floorNo, label: input.label } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: block.buildingId, eventType: 'property.floor.created.v1', aggregateType: 'floor', aggregateId: floor.id, payload: { floorId: floor.id, blockId: floor.blockId } }) });
      return mapFloor(floor);
    });
  }

  async listFloors(projectId: string, blockId: string): Promise<FloorView[]> {
    const values = await this.replica.floor.findMany({ where: { blockId, block: { building: { projectId } } }, orderBy: { floorNo: 'asc' } });
    return values.map(mapFloor);
  }

  async createApartment(input: { projectId: string; buildingId: string; blockId: string; floorId: string; code: string; netAreaSqm: string; grossAreaSqm?: string; handoverStatus?: string }): Promise<ApartmentView> {
    return this.primary.$transaction(async (tx) => {
      const [building, block, floor] = await Promise.all([
        tx.building.findFirst({ where: { id: input.buildingId, projectId: input.projectId, status: 'ACTIVE' } }),
        tx.buildingBlock.findFirst({ where: { id: input.blockId, buildingId: input.buildingId, status: 'ACTIVE' } }),
        tx.floor.findFirst({ where: { id: input.floorId }, include: { block: true } }),
      ]);
      if (!building || !block || !floor || floor.blockId !== input.blockId) throw new Error('Apartment hierarchy is invalid');
      const apartment = await tx.apartment.create({ data: { ...input, handoverStatus: input.handoverStatus as 'NOT_READY' | 'SCHEDULED' | 'HANDED_OVER' | 'REJECTED' | undefined } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: input.buildingId, eventType: 'property.apartment.created.v1', aggregateType: 'apartment', aggregateId: apartment.id, payload: { apartmentId: apartment.id, buildingId: input.buildingId, code: apartment.code } }) });
      return mapApartment(apartment);
    });
  }

  async getApartment(projectId: string, apartmentId: string): Promise<ApartmentView | null> {
    const value = await this.replica.apartment.findFirst({ where: { id: apartmentId, projectId } });
    return value ? mapApartment(value) : null;
  }

  async updateApartment(input: { projectId: string; apartmentId: string; netAreaSqm?: string; grossAreaSqm?: string; status?: string; handoverStatus?: string; expectedVersion?: number }): Promise<ApartmentView> {
    return this.primary.$transaction(async (tx) => {
      const apartment = await tx.apartment.findFirst({ where: { id: input.apartmentId, projectId, ...(input.expectedVersion === undefined ? {} : { version: input.expectedVersion }) } });
      if (!apartment) throw new Error('Apartment not found or version conflict');
      const updated = await tx.apartment.update({ where: { id: apartment.id }, data: { netAreaSqm: input.netAreaSqm, grossAreaSqm: input.grossAreaSqm, status: input.status as 'PLANNED' | 'AVAILABLE' | 'OCCUPIED' | 'HANDED_OVER' | 'MAINTENANCE' | 'INACTIVE' | undefined, handoverStatus: input.handoverStatus as 'NOT_READY' | 'SCHEDULED' | 'HANDED_OVER' | 'REJECTED' | undefined, handedOverAt: input.handoverStatus === 'HANDED_OVER' && !apartment.handedOverAt ? new Date() : undefined, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: eventData({ projectId, buildingId: updated.buildingId, eventType: 'property.apartment.updated.v1', aggregateType: 'apartment', aggregateId: updated.id, payload: { apartmentId: updated.id, version: updated.version } }) });
      return mapApartment(updated);
    });
  }

  async listResidentApartments(projectId: string, residentId: string): Promise<ResidentApartmentView[]> {
    const active = await this.replica.activeApartmentContext.findUnique({ where: { residentId_projectId: { residentId, projectId } } });
    const mappings = await this.replica.apartmentResidentMap.findMany({
      where: { residentId, status: { in: ['ACTIVE', 'PENDING'] }, apartment: { projectId } },
      include: { apartment: { select: { projectId: true, buildingId: true, code: true } } },
      orderBy: [{ status: 'asc' }, { startsAt: 'desc' }],
    });
    return mappings.map((mapping) => ({ apartmentId: mapping.apartmentId, projectId: mapping.apartment.projectId, buildingId: mapping.apartment.buildingId, apartmentCode: mapping.apartment.code, role: mapping.role, status: mapping.status, isActive: active?.apartmentId === mapping.apartmentId }));
  }

  async switchActiveApartment(input: { projectId: string; residentId: string; apartmentId: string }): Promise<{ residentId: string; projectId: string; apartmentId: string; selectedAt: Date }> {
    return this.primary.$transaction(async (tx) => {
      const mapping = await tx.apartmentResidentMap.findFirst({ where: { residentId: input.residentId, apartmentId: input.apartmentId, status: 'ACTIVE', apartment: { projectId: input.projectId } }, select: { apartmentId: true } });
      if (!mapping) throw new Error('Resident is not actively associated with the apartment');
      const selectedAt = new Date();
      await tx.activeApartmentContext.upsert({ where: { residentId_projectId: { residentId: input.residentId, projectId: input.projectId } }, create: { residentId: input.residentId, projectId: input.projectId, apartmentId: input.apartmentId, selectedAt }, update: { apartmentId: input.apartmentId, selectedAt, version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: undefined, eventType: 'property.resident.active_apartment_switched.v1', aggregateType: 'resident', aggregateId: input.residentId, payload: { residentId: input.residentId, apartmentId: input.apartmentId } }) });
      return { ...input, selectedAt };
    });
  }

  async createResident(input: { projectId: string; externalRef: string; userId: string; fullName: string; phone?: string; email?: string }): Promise<ResidentView> {
    return this.primary.$transaction(async (tx) => {
      const { projectId, ...residentData } = input;
      const resident = await tx.resident.create({ data: residentData });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, eventType: 'property.resident.created.v1', aggregateType: 'resident', aggregateId: resident.id, payload: { residentId: resident.id, userId: resident.userId } }) });
      return mapResident(resident);
    });
  }

  async getResident(projectId: string, residentId: string): Promise<ResidentView | null> {
    const value = await this.replica.resident.findFirst({ where: { id: residentId, apartments: { some: { apartment: { projectId } } } } });
    return value ? mapResident(value) : null;
  }

  async updateResident(input: { projectId: string; residentId: string; fullName?: string; phone?: string; email?: string; status?: string }): Promise<ResidentView> {
    return this.primary.$transaction(async (tx) => {
      const resident = await tx.resident.findFirst({ where: { id: input.residentId, apartments: { some: { apartment: { projectId } } } } });
      if (!resident) throw new Error('Resident not found in project');
      const updated = await tx.resident.update({ where: { id: resident.id }, data: { fullName: input.fullName, phone: input.phone, email: input.email, status: input.status as 'ACTIVE' | 'INACTIVE' | 'DECEASED' | undefined } });
      await tx.outboxEvent.create({ data: eventData({ projectId, eventType: 'property.resident.updated.v1', aggregateType: 'resident', aggregateId: updated.id, payload: { residentId: updated.id } }) });
      return mapResident(updated);
    });
  }

  async listApartmentVehicles(projectId: string, apartmentId: string): Promise<VehicleView[]> {
    const values = await this.replica.vehicle.findMany({ where: { apartmentId, apartment: { projectId } }, orderBy: { licensePlate: 'asc' } });
    return values.map(mapVehicle);
  }

  async createVehicle(input: { projectId: string; residentId: string; apartmentId: string; externalRef: string; type: string; licensePlate: string; registrationNumber?: string; registrationObjectRef?: string }): Promise<VehicleView> {
    return this.primary.$transaction(async (tx) => {
      const mapping = await tx.apartmentResidentMap.findFirst({ where: { residentId: input.residentId, apartmentId: input.apartmentId, status: 'ACTIVE', apartment: { projectId: input.projectId } } });
      if (!mapping) throw new Error('Resident is not actively associated with the apartment');
      const { projectId, ...vehicleData } = input;
      const vehicle = await tx.vehicle.create({ data: vehicleData as never });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: undefined, eventType: 'property.vehicle.created.v1', aggregateType: 'vehicle', aggregateId: vehicle.id, payload: { vehicleId: vehicle.id, apartmentId: vehicle.apartmentId, residentId: vehicle.residentId } }) });
      return mapVehicle(vehicle);
    });
  }

  async updateVehicle(input: { projectId: string; vehicleId: string; residentId: string; licensePlate?: string; status?: string; registrationNumber?: string; registrationObjectRef?: string }): Promise<VehicleView> {
    return this.primary.$transaction(async (tx) => {
      const existing = await tx.vehicle.findFirst({ where: { id: input.vehicleId, residentId: input.residentId, apartment: { projectId: input.projectId } } });
      if (!existing) throw new Error('Vehicle not found');
      const vehicle = await tx.vehicle.update({ where: { id: existing.id }, data: { licensePlate: input.licensePlate, status: input.status as 'ACTIVE' | 'INACTIVE' | 'LOST' | undefined, registrationNumber: input.registrationNumber, registrationObjectRef: input.registrationObjectRef } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, eventType: 'property.vehicle.updated.v1', aggregateType: 'vehicle', aggregateId: vehicle.id, payload: { vehicleId: vehicle.id, apartmentId: vehicle.apartmentId, residentId: vehicle.residentId } }) });
      return mapVehicle(vehicle);
    });
  }

  async listDirectory(projectId: string, buildingId: string, departmentId?: string): Promise<ContactDirectoryView[]> {
    const values = await this.replica.contactDirectoryEntry.findMany({ where: { projectId, buildingId, status: 'ACTIVE', ...(departmentId ? { departmentId } : {}) }, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    return values.map((value) => ({ ...value }));
  }

  async createDirectoryEntry(input: { projectId: string; buildingId: string; departmentId: string; name: string; title?: string; phone?: string; email?: string; extension?: string; priority?: number }): Promise<ContactDirectoryView> {
    return this.primary.$transaction(async (tx) => {
      const building = await tx.building.findFirst({ where: { id: input.buildingId, projectId, status: 'ACTIVE' } });
      if (!building) throw new Error('Building is outside the project');
      const entry = await tx.contactDirectoryEntry.create({ data: input });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, buildingId: input.buildingId, eventType: 'property.contact_directory.updated.v1', aggregateType: 'contact_directory_entry', aggregateId: entry.id, payload: { contactId: entry.id, buildingId: input.buildingId, departmentId: input.departmentId } }) });
      return { ...entry };
    });
  }

  async createImportJob(input: { projectId: string; buildingId?: string; fileName: string }): Promise<string> {
    const job = await this.primary.importJob.create({ data: input });
    return job.id;
  }

  async updateImportJob(importJobId: string, input: { status: string; totalRows?: number; successRows?: number; failedRows?: number; errorCount?: number; lastError?: string; startedAt?: Date; completedAt?: Date }): Promise<void> {
    await this.primary.importJob.update({ where: { id: importJobId }, data: { ...input, status: input.status as 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' } });
  }

  async importBatch(batch: ImportBatch): Promise<{ residentCount: number; vehicleCount: number; residentIds: string[]; apartmentIds: string[] }> {
    return this.primary.$transaction(async (tx) => {
      const residentInsert = batch.residents.length > 0
        ? await tx.resident.createMany({ data: batch.residents.map((row) => ({ externalRef: row.externalRef, userId: row.userId, fullName: row.fullName, phone: row.phone, email: row.email, status: row.status ?? 'ACTIVE' })), skipDuplicates: true })
        : { count: 0 };
      const residentRefs = batch.residents.map((row) => row.externalRef);
      const residents = residentRefs.length > 0 ? await tx.resident.findMany({ where: { externalRef: { in: residentRefs } }, select: { id: true, externalRef: true } }) : [];
      const residentByRef = new Map(residents.map((resident) => [resident.externalRef, resident.id]));
      const mappings = batch.residents.filter((row) => row.apartmentId).map((row) => {
        const residentId = residentByRef.get(row.externalRef);
        if (!residentId) throw new Error(`Resident ${row.externalRef} was not persisted`);
        return { apartmentId: row.apartmentId as string, residentId, role: row.role ?? 'MEMBER' as const, activeMapKey: `${row.apartmentId}:${residentId}`, status: 'ACTIVE' as const };
      });
      if (mappings.length > 0) await tx.apartmentResidentMap.createMany({ data: mappings, skipDuplicates: true });
      const vehicleRows = batch.vehicles.map((row) => {
        const residentId = residentByRef.get(row.residentExternalRef);
        if (!residentId) throw new Error(`Vehicle resident ${row.residentExternalRef} is missing`);
        return { ...row, residentId };
      });
      let vehicleInsert = { count: 0 };
      if (vehicleRows.length > 0) {
        const apartmentIds = Array.from(new Set(vehicleRows.map((row) => row.apartmentId)));
        const validApartments = await tx.apartment.findMany({ where: { id: { in: apartmentIds }, projectId: batch.projectId }, select: { id: true } });
        const validApartmentIds = new Set(validApartments.map((apartment) => apartment.id));
        const validMappings = await tx.apartmentResidentMap.findMany({ where: { apartmentId: { in: apartmentIds }, residentId: { in: residents.map((resident) => resident.id) }, status: 'ACTIVE' }, select: { apartmentId: true, residentId: true } });
        const mappingKeys = new Set(validMappings.map((mapping) => `${mapping.apartmentId}:${mapping.residentId}`));
        for (const row of vehicleRows) if (!validApartmentIds.has(row.apartmentId) || !mappingKeys.has(`${row.apartmentId}:${row.residentId}`)) throw new Error(`Vehicle ${row.externalRef} is outside resident apartment scope`);
        vehicleInsert = await tx.vehicle.createMany({ data: vehicleRows.map((row) => ({ externalRef: row.externalRef, residentId: row.residentId, apartmentId: row.apartmentId, type: row.type, licensePlate: row.licensePlate, registrationNumber: row.registrationNumber, registrationObjectRef: row.registrationObjectRef })), skipDuplicates: true });
      }
      const events = [
        ...batch.residents.map((row) => eventData({ projectId: batch.projectId, buildingId: batch.buildingId, eventType: 'property.resident.imported.v1', aggregateType: 'resident', aggregateId: residentByRef.get(row.externalRef) ?? row.externalRef, payload: { externalRef: row.externalRef, importJobId: batch.importJobId } })),
        ...vehicleRows.map((row) => eventData({ projectId: batch.projectId, buildingId: batch.buildingId, eventType: 'property.vehicle.imported.v1', aggregateType: 'vehicle', aggregateId: row.externalRef, payload: { externalRef: row.externalRef, importJobId: batch.importJobId } })),
      ];
      if (events.length > 0) await tx.outboxEvent.createMany({ data: events });
      return { residentCount: residentInsert.count, vehicleCount: vehicleInsert.count, residentIds: residents.map((resident) => resident.id), apartmentIds: Array.from(new Set(vehicleRows.map((row) => row.apartmentId))) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  }
}
