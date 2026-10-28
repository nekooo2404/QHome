import { assertProjectScope, normalizePlate } from '../domain/models';
import { PropertyResidentNotFoundError, PropertyResidentValidationError } from '../domain/errors';
import { PropertyResidentCacheKeys, PropertyResidentRepository, ReadCache } from './ports';

export class PropertyResidentService {
  constructor(
    private readonly repository: PropertyResidentRepository,
    private readonly cache: ReadCache,
    private readonly keys: PropertyResidentCacheKeys,
    private readonly cacheTtlSeconds = 60,
  ) {}

  async createBuilding(projectId: string, input: { code: string; name: string; address?: string }) {
    this.requireText(projectId, 'projectId');
    this.requireText(input.code, 'code');
    this.requireText(input.name, 'name');
    return this.repository.createBuilding({ projectId, ...input });
  }

  listBuildings(projectId: string, take = 50, cursor?: string) {
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new PropertyResidentValidationError('take must be between 1 and 100');
    return this.repository.listBuildings(projectId, take, cursor);
  }

  async getBuilding(projectId: string, buildingId: string) {
    const building = await this.repository.getBuilding(projectId, buildingId);
    if (!building) throw new PropertyResidentNotFoundError('Building not found');
    return building;
  }

  updateBuilding(projectId: string, input: Parameters<PropertyResidentRepository['updateBuilding']>[0]) {
    assertProjectScope(projectId, input.projectId);
    return this.repository.updateBuilding(input);
  }

  createBlock(projectId: string, input: Parameters<PropertyResidentRepository['createBlock']>[0]) {
    assertProjectScope(projectId, input.projectId);
    return this.repository.createBlock(input);
  }

  listBlocks(projectId: string, buildingId: string) {
    return this.repository.listBlocks(projectId, buildingId);
  }

  createFloor(projectId: string, input: Parameters<PropertyResidentRepository['createFloor']>[0]) {
    assertProjectScope(projectId, input.projectId);
    if (!Number.isInteger(input.floorNo)) throw new PropertyResidentValidationError('floorNo must be an integer');
    return this.repository.createFloor(input);
  }

  listFloors(projectId: string, blockId: string) {
    return this.repository.listFloors(projectId, blockId);
  }

  async createApartment(projectId: string, input: Parameters<PropertyResidentRepository['createApartment']>[0]) {
    assertProjectScope(projectId, input.projectId);
    if (!input.code || Number(input.netAreaSqm) <= 0) throw new PropertyResidentValidationError('Apartment code and positive net area are required');
    return this.repository.createApartment(input);
  }

  async getApartment(projectId: string, apartmentId: string) {
    const key = this.keys.apartment(projectId, apartmentId);
    const cached = await this.cache.get<Awaited<ReturnType<PropertyResidentRepository['getApartment']>>>(key);
    if (cached) return cached;
    const apartment = await this.repository.getApartment(projectId, apartmentId);
    if (!apartment) throw new PropertyResidentNotFoundError('Apartment not found');
    await this.cache.set(key, apartment, this.cacheTtlSeconds);
    return apartment;
  }

  async updateApartment(projectId: string, input: Parameters<PropertyResidentRepository['updateApartment']>[0]) {
    assertProjectScope(projectId, input.projectId);
    const apartment = await this.repository.updateApartment(input);
    await this.cache.delete(this.keys.apartment(projectId, input.apartmentId));
    return apartment;
  }

  async listResidentApartments(projectId: string, residentId: string) {
    const key = this.keys.residentApartments(projectId, residentId);
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const apartments = await this.repository.listResidentApartments(projectId, residentId);
    await this.cache.set(key, apartments, this.cacheTtlSeconds);
    return apartments;
  }

  async switchActiveApartment(projectId: string, residentId: string, apartmentId: string) {
    const context = await this.repository.switchActiveApartment({ projectId, residentId, apartmentId });
    await this.cache.delete(this.keys.residentApartments(projectId, residentId));
    return context;
  }

  async createResident(projectId: string, input: Parameters<PropertyResidentRepository['createResident']>[0]) {
    assertProjectScope(projectId, input.projectId);
    this.requireText(input.externalRef, 'externalRef');
    this.requireText(input.userId, 'userId');
    this.requireText(input.fullName, 'fullName');
    return this.repository.createResident(input);
  }

  async getResident(projectId: string, residentId: string) {
    const resident = await this.repository.getResident(projectId, residentId);
    if (!resident) throw new PropertyResidentNotFoundError('Resident not found');
    return resident;
  }

  updateResident(projectId: string, input: Parameters<PropertyResidentRepository['updateResident']>[0]) {
    assertProjectScope(projectId, input.projectId);
    return this.repository.updateResident(input);
  }

  async listApartmentVehicles(projectId: string, apartmentId: string) {
    const key = this.keys.apartmentVehicles(projectId, apartmentId);
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const vehicles = await this.repository.listApartmentVehicles(projectId, apartmentId);
    await this.cache.set(key, vehicles, this.cacheTtlSeconds);
    return vehicles;
  }

  async createVehicle(projectId: string, input: Parameters<PropertyResidentRepository['createVehicle']>[0]) {
    assertProjectScope(projectId, input.projectId);
    const vehicle = await this.repository.createVehicle({ ...input, licensePlate: normalizePlate(input.licensePlate) });
    await this.cache.delete(this.keys.apartmentVehicles(projectId, input.apartmentId));
    return vehicle;
  }

  async updateVehicle(projectId: string, input: Parameters<PropertyResidentRepository['updateVehicle']>[0]) {
    assertProjectScope(projectId, input.projectId);
    const vehicle = await this.repository.updateVehicle({ ...input, licensePlate: input.licensePlate ? normalizePlate(input.licensePlate) : undefined });
    const apartmentId = (vehicle as { apartmentId?: string }).apartmentId;
    if (apartmentId) await this.cache.delete(this.keys.apartmentVehicles(projectId, apartmentId));
    return vehicle;
  }

  async listDirectory(projectId: string, buildingId: string, departmentId?: string) {
    const key = this.keys.directory(projectId, buildingId, departmentId);
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const entries = await this.repository.listDirectory(projectId, buildingId, departmentId);
    await this.cache.set(key, entries, this.cacheTtlSeconds);
    return entries;
  }

  async createDirectoryEntry(projectId: string, input: Parameters<PropertyResidentRepository['createDirectoryEntry']>[0]) {
    assertProjectScope(projectId, input.projectId);
    const entry = await this.repository.createDirectoryEntry(input);
    await this.cache.delete(this.keys.directory(projectId, input.buildingId, input.departmentId));
    await this.cache.delete(this.keys.directory(projectId, input.buildingId));
    return entry;
  }

  private requireText(value: string | undefined, name: string): asserts value is string {
    if (!value || value.trim().length === 0 || value.length > 500) throw new PropertyResidentValidationError(`${name} is required`);
  }
}
