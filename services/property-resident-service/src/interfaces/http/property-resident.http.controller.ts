import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PropertyResidentService } from '../../application/property-resident.service';
import { BulkImportService } from '../../application/bulk-import.service';
import { ContextRequest, getRequestContext } from '../../../../../libs/common/src/base-microservice';
import { assertActorScope, assertApartmentScope, assertStaffScope, isStaffContext } from '../../../../../libs/common/src/apartment-scope';

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
  createBuilding(@Req() request: ContextRequest, @Body() body: { code: string; name: string; address?: string }) {
    const context = getRequestContext(request); assertStaffScope(context); return this.service.createBuilding(context.tenantId, body);
  }

  @Get('/buildings/:buildingId')
  getBuilding(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string) {
    return this.service.getBuilding(projectId, buildingId);
  }

  @Patch('/buildings/:buildingId')
  updateBuilding(@Req() request: ContextRequest, @Param('buildingId') buildingId: string, @Body() body: { code?: string; name?: string; address?: string; status?: string; expectedVersion?: number }) {
    const context = getRequestContext(request); assertStaffScope(context); return this.service.updateBuilding(context.tenantId, { projectId: context.tenantId, buildingId, ...body });
  }

  @Get('/buildings/:buildingId/blocks')
  listBlocks(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string) {
    return this.service.listBlocks(projectId, buildingId);
  }

  @Post('/buildings/:buildingId/blocks')
  createBlock(@Req() request: ContextRequest, @Param('buildingId') buildingId: string, @Body() body: { code: string; name: string }) {
    const context = getRequestContext(request); assertStaffScope(context); return this.service.createBlock(context.tenantId, { projectId: context.tenantId, buildingId, ...body });
  }

  @Get('/blocks/:blockId/floors')
  listFloors(@Headers('x-tenant-id') projectId: string, @Param('blockId') blockId: string) {
    return this.service.listFloors(projectId, blockId);
  }

  @Post('/blocks/:blockId/floors')
  createFloor(@Req() request: ContextRequest, @Param('blockId') blockId: string, @Body() body: { floorNo: number; label: string }) {
    const context = getRequestContext(request); assertStaffScope(context); return this.service.createFloor(context.tenantId, { projectId: context.tenantId, blockId, ...body });
  }

  @Post('/apartments')
  createApartment(@Req() request: ContextRequest, @Body() body: { buildingId: string; blockId: string; floorId: string; code: string; netAreaSqm: string; grossAreaSqm?: string; handoverStatus?: string }) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    return this.service.createApartment(context.tenantId, { projectId: context.tenantId, ...body });
  }

  @Get('/apartments/:apartmentId')
  getApartment(@Req() request: ContextRequest, @Param('apartmentId') apartmentId: string) {
    const context = getRequestContext(request);
    assertApartmentScope(context, apartmentId);
    return this.service.getApartment(context.tenantId, apartmentId);
  }

  @Patch('/apartments/:apartmentId')
  updateApartment(@Req() request: ContextRequest, @Param('apartmentId') apartmentId: string, @Body() body: { netAreaSqm?: string; grossAreaSqm?: string; status?: string; handoverStatus?: string; expectedVersion?: number }) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    assertApartmentScope(context, apartmentId);
    return this.service.updateApartment(context.tenantId, { projectId: context.tenantId, apartmentId, ...body });
  }

  @Post('/residents')
  createResident(@Req() request: ContextRequest, @Body() body: { externalRef: string; userId: string; fullName: string; phone?: string; email?: string }) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    return this.service.createResident(context.tenantId, { projectId: context.tenantId, ...body });
  }

  @Get('/residents/:residentId')
  getResident(@Req() request: ContextRequest, @Param('residentId') residentId: string) {
    const context = getRequestContext(request);
    assertActorScope(context, residentId);
    return this.service.getResident(context.tenantId, residentId);
  }

  @Patch('/residents/:residentId')
  updateResident(@Req() request: ContextRequest, @Param('residentId') residentId: string, @Body() body: { fullName?: string; phone?: string; email?: string; status?: string; temporaryResidenceStatus?: string }) {
    const context = getRequestContext(request);
    assertActorScope(context, residentId);
    if (body.temporaryResidenceStatus !== undefined) assertStaffScope(context);
    return this.service.updateResident(context.tenantId, { projectId: context.tenantId, residentId, ...body });
  }

  @Get('/residents/:residentId/apartments')
  listResidentApartments(@Req() request: ContextRequest, @Param('residentId') residentId: string) {
    const context = getRequestContext(request);
    assertActorScope(context, residentId);
    return this.service.listResidentApartments(context.tenantId, residentId);
  }

  @Post('/residents/:residentId/active-apartment')
  switchActiveApartment(@Req() request: ContextRequest, @Param('residentId') residentId: string, @Body() body: { apartmentId: string }) {
    const context = getRequestContext(request);
    assertActorScope(context, residentId);
    assertApartmentScope(context, body.apartmentId);
    return this.service.switchActiveApartment(context.tenantId, residentId, body.apartmentId);
  }

  @Get('/apartments/:apartmentId/vehicles')
  listApartmentVehicles(@Req() request: ContextRequest, @Param('apartmentId') apartmentId: string) {
    const context = getRequestContext(request);
    assertApartmentScope(context, apartmentId);
    return this.service.listApartmentVehicles(context.tenantId, apartmentId);
  }

  @Post('/vehicles')
  createVehicle(@Req() request: ContextRequest, @Body() body: { residentId: string; apartmentId: string; externalRef: string; type: string; licensePlate: string; registrationNumber?: string; registrationObjectRef?: string }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, body.apartmentId);
    assertActorScope(context, body.residentId);
    return this.service.createVehicle(context.tenantId, { projectId: context.tenantId, ...body });
  }

  @Patch('/vehicles/:vehicleId')
  updateVehicle(@Req() request: ContextRequest, @Param('vehicleId') vehicleId: string, @Body() body: { licensePlate?: string; status?: string; registrationNumber?: string; registrationObjectRef?: string }) {
    const context = getRequestContext(request); if (!isStaffContext(context) && !context.actorId) throw new Error('authenticated actor context is required'); return this.service.updateVehicle(context.tenantId, { projectId: context.tenantId, vehicleId, residentId: context.actorId ?? context.subject!, ...body });
  }

  @Get('/buildings/:buildingId/contacts')
  listDirectory(@Headers('x-tenant-id') projectId: string, @Param('buildingId') buildingId: string, @Query('departmentId') departmentId?: string) {
    return this.service.listDirectory(projectId, buildingId, departmentId);
  }

  @Post('/buildings/:buildingId/contacts')
  createDirectoryEntry(@Req() request: ContextRequest, @Param('buildingId') buildingId: string, @Body() body: { departmentId: string; name: string; title?: string; phone?: string; email?: string; extension?: string; priority?: number }) {
    const context = getRequestContext(request); assertStaffScope(context); return this.service.createDirectoryEntry(context.tenantId, { projectId: context.tenantId, buildingId, ...body });
  }

  @Post('/imports/residents-vehicles')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: process.env.PROPERTY_RESIDENT_IMPORT_TMP_DIR ?? './var/imports',
      filename: (_request, file, callback) => callback(null, `${randomUUID()}.xlsx`),
    }),
    limits: { fileSize: Number(process.env.PROPERTY_RESIDENT_IMPORT_MAX_BYTES ?? 50 * 1024 * 1024), files: 1 },
  }))
  async importResidentsAndVehicles(@Req() request: ContextRequest, @Headers('x-building-id') buildingId: string | undefined, @UploadedFile() file: UploadedFileLike) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    const projectId = context.tenantId;
    if (!file?.path) throw new Error('Excel file is required');
    try {
      return await this.importer.importWorkbook({ projectId, buildingId, fileName: file.originalname, stream: createReadStream(file.path) });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }
}
