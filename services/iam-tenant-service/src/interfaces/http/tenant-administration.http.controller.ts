import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ContextRequest, getRequestContext } from '../../../../../libs/common/src/base-microservice';
import { AuthorizationService } from '../../application/authorization.service';
import { TenantAdministrationService } from '../../application/tenant-administration.service';
import { TenantAdminContext } from '../../application/ports';

type ProjectBody = { code: string; name: string };
type BuildingBody = { code: string; name: string };
type DepartmentBody = { code: string; name: string; description?: string };
type UserBody = { email: string; displayName: string; userType: 'BQL' | 'RESIDENT'; password: string; apartmentId?: string; buildingIds?: string[] };
type RoleBody = { userId: string; roleCode: string; buildingIds?: string[] };
type DepartmentMemberBody = { departmentCode: string; userId: string };
type DepartmentRoleBody = { departmentCode: string; roleCode: string };
type OverrideBody = { userId: string; permission: string; effect: 'ALLOW' | 'DENY'; buildingId?: string };

@Controller('/v1/iam')
export class TenantAdministrationHttpController {
  constructor(
    private readonly administration: TenantAdministrationService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Post('/projects')
  createProject(@Req() request: ContextRequest, @Body() body: ProjectBody) {
    const context = this.context(request);
    this.requiredText(body?.code, 'code', 64);
    this.requiredText(body?.name, 'name', 200);
    return this.administration.createProject(context, body);
  }

  @Post('/buildings')
  createBuilding(@Req() request: ContextRequest, @Body() body: BuildingBody) {
    const context = this.context(request);
    this.requiredText(body?.code, 'code', 64);
    this.requiredText(body?.name, 'name', 200);
    return this.administration.createBuilding(context, body);
  }

  @Post('/departments')
  createDepartment(@Req() request: ContextRequest, @Body() body: DepartmentBody) {
    const context = this.context(request);
    this.requiredText(body?.code, 'code', 64);
    this.requiredText(body?.name, 'name', 200);
    return this.administration.createDepartment(context, body);
  }

  @Post('/users')
  createUser(@Req() request: ContextRequest, @Body() body: UserBody) {
    const context = this.context(request);
    this.requiredText(body?.email, 'email', 320);
    this.requiredText(body?.displayName, 'displayName', 200);
    this.requiredText(body?.password, 'password', 128);
    if (!['BQL', 'RESIDENT'].includes(body.userType)) throw new Error('userType is invalid');
    return this.administration.provisionUser(context, body);
  }

  @Post('/roles/assign')
  assignRole(@Req() request: ContextRequest, @Body() body: RoleBody) {
    const context = this.context(request);
    this.requiredText(body?.userId, 'userId', 128);
    this.requiredText(body?.roleCode, 'roleCode', 96);
    return this.administration.assignRole(context, body);
  }

  @Post('/departments/members')
  addDepartmentMember(@Req() request: ContextRequest, @Body() body: DepartmentMemberBody) {
    const context = this.context(request);
    this.requiredText(body?.departmentCode, 'departmentCode', 64);
    this.requiredText(body?.userId, 'userId', 128);
    return this.administration.addDepartmentMember(context, body);
  }

  @Post('/departments/roles')
  bindDepartmentRole(@Req() request: ContextRequest, @Body() body: DepartmentRoleBody) {
    const context = this.context(request);
    this.requiredText(body?.departmentCode, 'departmentCode', 64);
    this.requiredText(body?.roleCode, 'roleCode', 96);
    return this.administration.bindDepartmentRole(context, body);
  }

  @Post('/permission-overrides')
  @HttpCode(204)
  async override(@Req() request: ContextRequest, @Body() body: OverrideBody): Promise<void> {
    const context = this.context(request);
    this.requiredText(body?.userId, 'userId', 128);
    this.requiredText(body?.permission, 'permission', 160);
    if (!['ALLOW', 'DENY'].includes(body.effect)) throw new Error('effect is invalid');
    await this.authorization.replacePermissionOverride({ ...body, projectId: context.projectId, actorUserId: context.actorUserId, authenticatedTenantId: context.authenticatedTenantId, sessionId: context.sessionId, correlationId: context.correlationId });
  }

  private context(request: ContextRequest): TenantAdminContext {
    const transport = getRequestContext(request);
    if (!transport.actorId) throw new Error('authenticated actor context is required');
    return { actorUserId: transport.actorId, projectId: transport.tenantId, authenticatedTenantId: transport.tenantId, sessionId: transport.sessionId, correlationId: transport.correlationId };
  }

  private requiredText(value: unknown, name: string, maxLength: number): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw new Error(`${name} is invalid`);
  }
}
