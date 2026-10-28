import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import ExcelJS from 'exceljs';
import { ApartmentResidentRole, ImportBatch, ResidentImportRow, VehicleImportRow, VehicleType } from '../domain/models';
import { PropertyResidentValidationError } from '../domain/errors';
import { PropertyResidentCacheKeys, PropertyResidentRepository, ReadCache } from './ports';

export interface ImportSummary {
  importJobId: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  residentRows: number;
  vehicleRows: number;
}

export class BulkImportService {
  constructor(
    private readonly repository: PropertyResidentRepository,
    private readonly cache: ReadCache,
    private readonly keys: PropertyResidentCacheKeys,
    private readonly batchSize = 500,
  ) {}

  async importWorkbook(input: {
    projectId: string;
    buildingId?: string;
    fileName: string;
    stream: NodeJS.ReadableStream;
  }): Promise<ImportSummary> {
    if (!input.stream || typeof (input.stream as Readable).pipe !== 'function') throw new PropertyResidentValidationError('Readable workbook stream is required');
    const importJobId = await this.repository.createImportJob({ projectId: input.projectId, buildingId: input.buildingId, fileName: input.fileName });
    await this.repository.updateImportJob(importJobId, { status: 'RUNNING', startedAt: new Date() });
    const residents: ResidentImportRow[] = [];
    const vehicles: VehicleImportRow[] = [];
    let totalRows = 0;
    let successRows = 0;
    let failedRows = 0;
    let residentRows = 0;
    let vehicleRows = 0;

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookReader(input.stream as Readable, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'ignore',
      });
      for await (const worksheet of workbook) {
        let headers: string[] | undefined;
        for await (const row of worksheet) {
          const values = this.values(row.values as unknown[]);
          if (!headers) {
            headers = values.map((value) => this.header(value));
            continue;
          }
          if (values.every((value) => value === '')) continue;
          totalRows += 1;
          try {
            const data = this.toRecord(headers, values);
            const sheetName = String(worksheet.name).toLowerCase();
            if (sheetName.includes('vehicle') || data.licensePlate) {
              vehicles.push(this.parseVehicle(data));
              vehicleRows += 1;
            } else {
              residents.push(this.parseResident(data));
              residentRows += 1;
            }
          } catch {
            failedRows += 1;
          }
          if (residents.length + vehicles.length >= this.batchSize) {
            const residentBatch = residents.splice(0);
            const vehicleBatch = vehicles.splice(0);
            const flushed = await this.flush({ projectId: input.projectId, buildingId: input.buildingId, importJobId, residents: residentBatch, vehicles: vehicleBatch });
            successRows += flushed.residentCount + flushed.vehicleCount;
            if (flushed.residentCount + flushed.vehicleCount === 0) throw new Error('Import batch produced no persisted rows');
            await this.repository.updateImportJob(importJobId, { totalRows, successRows, failedRows });
          }
        }
      }
      if (residents.length > 0 || vehicles.length > 0) {
        const flushed = await this.flush({ projectId: input.projectId, buildingId: input.buildingId, importJobId, residents: residents.splice(0), vehicles: vehicles.splice(0) });
        successRows += flushed.residentCount + flushed.vehicleCount;
      }
      await this.repository.updateImportJob(importJobId, {
        status: failedRows === 0 ? 'COMPLETED' : 'PARTIAL',
        totalRows,
        successRows,
        failedRows,
        errorCount: failedRows,
        completedAt: new Date(),
      });
      return { importJobId, totalRows, successRows, failedRows, residentRows, vehicleRows };
    } catch (error) {
      await this.repository.updateImportJob(importJobId, {
        status: 'FAILED',
        totalRows,
        successRows,
        failedRows,
        errorCount: failedRows + 1,
        lastError: error instanceof Error ? error.message : 'Import failed',
        completedAt: new Date(),
      });
      throw error;
    } finally {
      const stream = input.stream as Readable;
      stream.destroy();
      await finished(stream, { cleanup: true }).catch(() => undefined);
    }
  }

  private async flush(batch: ImportBatch): Promise<{ residentCount: number; vehicleCount: number }> {
    const result = await this.repository.importBatch(batch);
    await Promise.all([
      ...result.apartmentIds.map((apartmentId) => this.cache.delete(this.keys.apartmentVehicles(batch.projectId, apartmentId))),
      ...result.residentIds.map((residentId) => this.cache.delete(this.keys.residentApartments(batch.projectId, residentId))),
    ]);
    return result;
  }

  private values(values: unknown[]): string[] {
    return Array.from({ length: Math.max(0, values.length - 1) }, (_, index) => this.cell(values[index + 1]));
  }

  private cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && value !== null && 'text' in value) return String((value as { text: unknown }).text);
    return String(value).trim();
  }

  private header(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/gu, '_');
  }

  private toRecord(headers: string[], values: string[]): Record<string, string> {
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  }

  private parseResident(data: Record<string, string>): ResidentImportRow {
    if (!data.external_ref || !data.user_id || !data.full_name) throw new Error('resident external_ref, user_id and full_name are required');
    const role = (data.role?.toUpperCase() || 'MEMBER') as ApartmentResidentRole;
    if (!['OWNER', 'TENANT', 'MEMBER'].includes(role)) throw new Error('invalid resident role');
    return { externalRef: data.external_ref, userId: data.user_id, fullName: data.full_name, phone: data.phone || undefined, email: data.email || undefined, apartmentId: data.apartment_id || undefined, role };
  }

  private parseVehicle(data: Record<string, string>): VehicleImportRow {
    const type = data.type?.toUpperCase() as VehicleType;
    if (!data.external_ref || !data.resident_external_ref || !data.apartment_id || !data.license_plate || !['CAR', 'MOTORBIKE', 'ELECTRIC_BICYCLE', 'BICYCLE', 'OTHER'].includes(type)) throw new Error('invalid vehicle row');
    return { externalRef: data.external_ref, residentExternalRef: data.resident_external_ref, apartmentId: data.apartment_id, type, licensePlate: data.license_plate, registrationNumber: data.registration_number || undefined, registrationObjectRef: data.registration_object_ref || undefined };
  }
}
