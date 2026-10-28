import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PropertyResidentService } from '../../application/property-resident.service';
import { BulkImportService } from '../../application/bulk-import.service';

interface UploadedFileLike {
  path: string;
  originalname: string;
}

@Controller('/v1')
export class PropertyResidentHttpController {
  constructor(
    private readonly service: PropertyResidentService,
    private readonly importer: BulkImportService,
  ) {}

  @Get('/buildings')
  listBuildings(@Headers('x-tenant-id') projectId: string, @Query('take') take?: string, @Query('cursor') cursor?: string) {
    return this.service.listBuildings(projectId, take ? Number(take) : 50, cursor);
  }

  @Post('/buildings')
  createBuilding(@Headers('x-tenant-id') projectId: string, @Body() body: { code: string; name: string; address?: string }) {
    return this.service.createBuilding(projectId, body);
  }

  @Get('/buildings/:buildingId')
  getBuilding(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string) {
    return this.service.getBuilding(projectId, buildingId);
  }

  @Patch('/buildings/:buildingId')
  updateBuilding(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string, @Body() body: { code?: string; name?: string; address?: string; status?: string; expectedVersion?: number }) {
    return this.service.updateBuilding(projectId, { projectId, buildingId, ...body });
  }

  @Get('/buildings/:buildingId/blocks')
  listBlocks(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string) {
    return this.service.listBlocks(projectId, buildingId);
  }

  @Post('/buildings/:buildingId/blocks')
  createBlock(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string, @Body() body: { code: string; name: string }) {
    return this.service.createBlock(projectId, { projectId, buildingId, ...body });
  }

  @Get('/blocks/:blockId/floors')
  listFloors(@Headers('x-tenant-id') projectId: string, @Param('blockId') blockId: string) {
    return this.service.listFloors(projectId, blockId);
  }

  @Post('/blocks/:blockId/floors')
  createFloor(@Headers('x-tenant-id') projectId: string, @Param('blockId') blockId: string, @Body() body: { floorNo: number; label: string }) {
    return this.service.createFloor(projectId, { projectId, blockId, ...body });
  }

  @Post('/apartments')
  createApartment(@Headers('x-tenant-id') projectId: string, @Body() body: { buildingId: string; blockId: string; floorId: string; code: string; netAreaSqm: string; grossAreaSqm?: string; handoverStatus?: string }) {
    return this.service.createApartment(projectId, { projectId, ...body });
  }

  @Get('/apartments/:apartmentId')
  getApartment(@Headers('x-tenant-id') projectId: string, @Param('apartmentId') apartmentId: string) {
    return this.service.getApartment(projectId, apartmentId);
  }

  @Patch('/apartments/:apartmentId')
  updateApartment(@Headers('x-tenant-id') projectId: string, @Param('apartmentId') apartmentId: string, @Body() body: { netAreaSqm?: string; grossAreaSqm?: string; status?: string; handoverStatus?: string; expectedVersion?: number }) {
    return this.service.updateApartment(projectId, { projectId, apartmentId, ...body });
  }

  @Post('/residents')
  createResident(@Headers('x-tenant-id') projectId: string, @Body() body: { externalRef: string; userId: string; fullName: string; phone?: string; email?: string }) {
    return this.service.createResident(projectId, { projectId, ...body });
  }

  @Get('/residents/:residentId')
  getResident(@Headers('x-tenant-id') projectId: string, @Param('residentId') residentId: string) {
    return this.service.getResident(projectId, residentId);
  }

  @Patch('/residents/:residentId')
  updateResident(@Headers('x-tenant-id') projectId: string, @Param('residentId') residentId: string, @Body() body: { fullName?: string; phone?: string; email?: string; status?: string }) {
    return this.service.updateResident(projectId, { projectId, residentId, ...body });
  }

  @Get('/residents/:residentId/apartments')
  listResidentApartments(@Headers('x-tenant-id') projectId: string, @Param('residentId') residentId: string) {
    return this.service.listResidentApartments(projectId, residentId);
  }

  @Post('/residents/:residentId/active-apartment')
  switchActiveApartment(@Headers('x-tenant-id') projectId: string, @Param('residentId') residentId: string, @Body() body: { apartmentId: string }) {
    return this.service.switchActiveApartment(projectId, residentId, body.apartmentId);
  }

  @Get('/apartments/:apartmentId/vehicles')
  listApartmentVehicles(@Headers('x-tenant-id') projectId: string, @Param('apartmentId') apartmentId: string) {
    return this.service.listApartmentVehicles(projectId, apartmentId);
  }

  @Post('/vehicles')
  createVehicle(@Headers('x-tenant-id') projectId: string, @Body() body: { residentId: string; apartmentId: string; externalRef: string; type: string; licensePlate: string; registrationNumber?: string; registrationObjectRef?: string }) {
    return this.service.createVehicle(projectId, { projectId, ...body });
  }

  @Patch('/vehicles/:vehicleId')
  updateVehicle(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') residentId: string, @Param('vehicleId') vehicleId: string, @Body() body: { licensePlate?: string; status?: string; registrationNumber?: string; registrationObjectRef?: string }) {
    return this.service.updateVehicle(projectId, { projectId, vehicleId, residentId, ...body });
  }

  @Get('/buildings/:buildingId/contacts')
  listDirectory(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string, @Query('departmentId') departmentId?: string) {
    return this.service.listDirectory(projectId, buildingId, departmentId);
  }

  @Post('/buildings/:buildingId/contacts')
  createDirectoryEntry(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string, @Body() body: { departmentId: string; name: string; title?: string; phone?: string; email?: string; extension?: string; priority?: number }) {
    return this.service.createDirectoryEntry(projectId, { projectId, buildingId, ...body });
  }

  @Post('/imports/residents-vehicles')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: process.env.PROPERTY_RESIDENT_IMPORT_TMP_DIR ?? './var/imports',
      filename: (_request, file, callback) => callback(null, `${randomUUID()}.xlsx`),
    }),
    limits: { fileSize: Number(process.env.PROPERTY_RESIDENT_IMPORT_MAX_BYTES ?? 50 * 1024 * 1024), files: 1 },
  }))
  async importResidentsAndVehicles(@Headers('x-tenant-id') projectId: string, @Headers('x-building-id') buildingId: string | undefined, @UploadedFile() file: UploadedFileLike) {
    if (!file?.path) throw new Error('Excel file is required');
    try {
      return await this.importer.importWorkbook({ projectId, buildingId, fileName: file.originalname, stream: createReadStream(file.path) });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }
}
