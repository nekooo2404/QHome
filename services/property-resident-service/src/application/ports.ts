import {
  ApartmentView,
  BuildingView,
  BuildingBlockView,
  ContactDirectoryView,
  FloorView,
  ImportBatch,
  ResidentApartmentView,
  ResidentView,
  VehicleView,
} from '../domain/models';

export interface ReadCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PropertyResidentRepository {
  createBuilding(input: { projectId: string; code: string; name: string; address?: string }): Promise<BuildingView>;
  listBuildings(projectId: string, take: number, cursor?: string): Promise<{ items: BuildingView[]; nextCursor?: string }>;
  getBuilding(projectId: string, buildingId: string): Promise<BuildingView | null>;
  updateBuilding(input: { projectId: string; buildingId: string; code?: string; name?: string; address?: string; status?: string; expectedVersion?: number }): Promise<BuildingView>;
  createBlock(input: { projectId: string; buildingId: string; code: string; name: string }): Promise<BuildingBlockView>;
  listBlocks(projectId: string, buildingId: string): Promise<BuildingBlockView[]>;
  createFloor(input: { projectId: string; blockId: string; floorNo: number; label: string }): Promise<FloorView>;
  listFloors(projectId: string, blockId: string): Promise<FloorView[]>;
  createApartment(input: {
    projectId: string;
    buildingId: string;
    blockId: string;
    floorId: string;
    code: string;
    netAreaSqm: string;
    grossAreaSqm?: string;
    handoverStatus?: string;
  }): Promise<ApartmentView>;
  getApartment(projectId: string, apartmentId: string): Promise<ApartmentView | null>;
  updateApartment(input: { projectId: string; apartmentId: string; netAreaSqm?: string; grossAreaSqm?: string; status?: string; handoverStatus?: string; expectedVersion?: number }): Promise<ApartmentView>;
  listResidentApartments(projectId: string, residentId: string): Promise<ResidentApartmentView[]>;
  switchActiveApartment(input: { projectId: string; residentId: string; apartmentId: string }): Promise<{ residentId: string; projectId: string; apartmentId: string; selectedAt: Date }>;
  createResident(input: { projectId: string; externalRef: string; userId: string; fullName: string; phone?: string; email?: string }): Promise<ResidentView>;
  getResident(projectId: string, residentId: string): Promise<ResidentView | null>;
  updateResident(input: { projectId: string; residentId: string; fullName?: string; phone?: string; email?: string; status?: string }): Promise<ResidentView>;
  listApartmentVehicles(projectId: string, apartmentId: string): Promise<VehicleView[]>;
  createVehicle(input: { projectId: string; residentId: string; apartmentId: string; externalRef: string; type: string; licensePlate: string; registrationNumber?: string; registrationObjectRef?: string }): Promise<VehicleView>;
  updateVehicle(input: { projectId: string; vehicleId: string; residentId: string; licensePlate?: string; status?: string; registrationNumber?: string; registrationObjectRef?: string }): Promise<VehicleView>;
  listDirectory(projectId: string, buildingId: string, departmentId?: string): Promise<ContactDirectoryView[]>;
  createDirectoryEntry(input: { projectId: string; buildingId: string; departmentId: string; name: string; title?: string; phone?: string; email?: string; extension?: string; priority?: number }): Promise<ContactDirectoryView>;
  createImportJob(input: { projectId: string; buildingId?: string; fileName: string }): Promise<string>;
  updateImportJob(importJobId: string, input: { status: string; totalRows?: number; successRows?: number; failedRows?: number; errorCount?: number; lastError?: string; startedAt?: Date; completedAt?: Date }): Promise<void>;
  importBatch(batch: ImportBatch): Promise<{ residentCount: number; vehicleCount: number; residentIds: string[]; apartmentIds: string[] }>;
}

export interface PropertyResidentCacheKeys {
  apartment(projectId: string, apartmentId: string): string;
  directory(projectId: string, buildingId: string, departmentId?: string): string;
  residentApartments(projectId: string, residentId: string): string;
  apartmentVehicles(projectId: string, apartmentId: string): string;
}
