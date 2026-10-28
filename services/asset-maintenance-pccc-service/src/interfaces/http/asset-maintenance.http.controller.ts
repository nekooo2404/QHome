import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { MaintenanceService } from '../../application/maintenance.service';

@Controller('/v1')
export class AssetMaintenanceHttpController {
  constructor(private readonly service: MaintenanceService) {}

  @Post('/assets')
  createAsset(@Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Body() body: Record<string, unknown>) {
    return this.service.createAsset(body, actorId, correlationId);
  }

  @Get('/projects/:projectId/assets/:assetId')
  getAsset(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.service.getAsset(projectId, assetId);
  }

  @Patch('/projects/:projectId/assets/:assetId')
  updateAsset(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Body() body: { expectedVersion: number; patch: Record<string, unknown> }) {
    return this.service.updateAsset({ projectId, assetId, expectedVersion: body.expectedVersion, patch: body.patch, actorId, correlationId });
  }

  @Patch('/projects/:projectId/work-orders/:workOrderId/status')
  transitionWorkOrder(@Param('projectId') projectId: string, @Param('workOrderId') workOrderId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Body() body: { currentStatus: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED'; nextStatus: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED'; expectedVersion: number; reason?: string }) {
    return this.service.transitionWorkOrder({ ...body, projectId, workOrderId, actorId, correlationId });
  }

  @Post('/projects/:projectId/checklists/:executionId/submit')
  submitChecklist(@Param('projectId') projectId: string, @Param('executionId') executionId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Body() body: { buildingId: string; assetId?: string; templateId: string; results: Array<{ itemId: string; status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; severity?: 'NORMAL' | 'CRITICAL'; notes?: string; evidenceRef?: string }> }) {
    return this.service.submitChecklist({ ...body, projectId, executionId, actorId, correlationId });
  }
}
