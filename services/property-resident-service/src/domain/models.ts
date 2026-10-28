export type HandoverStatus = 'NOT_READY' | 'SCHEDULED' | 'HANDED_OVER' | 'REJECTED';
export type ApartmentResidentRole = 'OWNER' | 'TENANT' | 'MEMBER';
export type VehicleType = 'CAR' | 'MOTORBIKE' | 'ELECTRIC_BICYCLE' | 'BICYCLE' | 'OTHER';

export interface BuildingView {
  id: string;
  projectId: string;
  code: string;
  name: string;
  address: string | null;
  status: string;
  version: number;
}

export interface BuildingBlockView {
  id: string;
  buildingId: string;
  code: string;
  name: string;
  status: string;
}

export interface FloorView {
  id: string;
  blockId: string;
  floorNo: number;
  label: string;
}

export interface ApartmentView {
  id: string;
  projectId: string;
  buildingId: string;
  blockId: string;
  floorId: string;
  code: string;
  netAreaSqm: string;
  grossAreaSqm: string | null;
  status: string;
  handoverStatus: HandoverStatus;
  handedOverAt: string | null;
}

export interface ResidentView {
  id: string;
  userId: string;
  externalRef: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: string;
}

export interface ResidentApartmentView {
  apartmentId: string;
  projectId: string;
  buildingId: string;
  apartmentCode: string;
  role: ApartmentResidentRole;
  status: string;
  isActive: boolean;
}

export interface VehicleView {
  id: string;
  residentId: string;
  apartmentId: string;
  externalRef: string;
  type: VehicleType;
  licensePlate: string;
  registrationNumber: string | null;
  registrationObjectRef: string | null;
  status: string;
}

export interface ContactDirectoryView {
  id: string;
  projectId: string;
  buildingId: string;
  departmentId: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  extension: string | null;
  priority: number;
  status: string;
}

export interface ResidentImportRow {
  externalRef: string;
  userId: string;
  fullName: string;
  phone?: string;
  email?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
  apartmentId?: string;
  role?: ApartmentResidentRole;
}

export interface VehicleImportRow {
  externalRef: string;
  residentExternalRef: string;
  apartmentId: string;
  type: VehicleType;
  licensePlate: string;
  registrationNumber?: string;
  registrationObjectRef?: string;
}

export interface ImportBatch {
  projectId: string;
  buildingId?: string;
  importJobId: string;
  residents: ResidentImportRow[];
  vehicles: VehicleImportRow[];
}

export function assertProjectScope(expectedProjectId: string, actualProjectId: string): void {
  if (!expectedProjectId || expectedProjectId !== actualProjectId) {
    throw new PropertyResidentValidationError('Project scope mismatch');
  }
}

export function normalizePlate(plate: string): string {
  const normalized = plate.trim().toUpperCase().replace(/[\s.-]+/gu, '');
  if (!normalized || normalized.length > 32 || !/^[A-Z0-9]+$/u.test(normalized)) {
    throw new PropertyResidentValidationError('Invalid license plate');
  }
  return normalized;
}
import { PropertyResidentValidationError } from './errors';

