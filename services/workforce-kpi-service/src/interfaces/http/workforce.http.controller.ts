import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { WorkforceService } from '../../application/workforce.service';

@Controller('/v1/workforce')
export class WorkforceHttpController {
  constructor(private readonly service: WorkforceService) {}
  private context(projectId: string, actorId: string, correlationId: string, buildingId?: string) { if (!projectId || !actorId || !correlationId) throw new Error('request context is required'); return { projectId, actorId, correlationId, buildingId }; }

  @Post('/tasks') create(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Headers('x-building-id') buildingId: string | undefined, @Body() body: any) { return this.service.createTask(this.context(projectId, actorId, correlationId, buildingId), body); }
  @Get('/tasks') list(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Query() query: any) { return this.service.listTasks(this.context(projectId, actorId, correlationId), query); }
  @Get('/tasks/:taskId') get(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Param('taskId') taskId: string) { return this.service.getTask(this.context(projectId, actorId, correlationId), taskId); }
  @Patch('/tasks/:taskId/status') transition(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Param('taskId') taskId: string, @Body() body: { expectedVersion: number; nextStatus: any; reason?: string }) { return this.service.transition(this.context(projectId, actorId, correlationId), taskId, body); }
  @Post('/tasks/:taskId/rating') rate(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Param('taskId') taskId: string, @Body() body: { score: number; comment?: string }) { return this.service.rate(this.context(projectId, actorId, correlationId), taskId, body); }
  @Get('/kpi') kpi(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Query() query: any) { return this.service.getKpi(this.context(projectId, actorId, correlationId), query); }
  @Get('/kpi/leaderboard') leaderboard(@Headers('x-tenant-id') projectId: string, @Headers('x-actor-id') actorId: string, @Headers('x-correlation-id') correlationId: string, @Query() query: any) { return this.service.leaderboard(this.context(projectId, actorId, correlationId), query); }
}
