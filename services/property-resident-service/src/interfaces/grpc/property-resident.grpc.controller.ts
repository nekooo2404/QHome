import { Controller } from '@nestjs/common';
import { Ctx, GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { getGrpcRequestContext, GrpcCall } from '../../../../../libs/common/src/base-microservice';
import { PropertyResidentService } from '../../application/property-resident.service';

interface ApartmentRequest { apartmentId?: string }
interface BuildingRequest { buildingId?: string }
interface BlockRequest { blockId?: string }
interface ResidentApartmentsRequest { residentId?: string; projectId?: string }
interface SwitchRequest { residentId?: string; projectId?: string; apartmentId?: string }
interface VehicleRequest { apartmentId?: string }

@Controller()
export class PropertyResidentGrpcController {
  constructor(private readonly service: PropertyResidentService) {}

  @GrpcMethod('PropertyResidentService', 'GetApartment')
  async getApartment(request: ApartmentRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    const apartment = await this.service.getApartment(context.tenantId, this.required(request.apartmentId, 'apartment_id'));
    return apartment;
  }

  @GrpcMethod('PropertyResidentService', 'ListBuildingBlocks')
  async listBuildingBlocks(request: BuildingRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    return { blocks: await this.service.listBlocks(context.tenantId, this.required(request.buildingId, 'building_id')) };
  }

  @GrpcMethod('PropertyResidentService', 'ListBlockFloors')
  async listBlockFloors(request: BlockRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    return { floors: await this.service.listFloors(context.tenantId, this.required(request.blockId, 'block_id')) };
  }

  @GrpcMethod('PropertyResidentService', 'ListResidentApartments')
  async listResidentApartments(request: ResidentApartmentsRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    const projectId = request.projectId || context.tenantId;
    const items = await this.service.listResidentApartments(projectId, this.required(request.residentId, 'resident_id'));
    return { apartments: items };
  }

  @GrpcMethod('PropertyResidentService', 'SwitchActiveApartment')
  async switchActiveApartment(request: SwitchRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    const projectId = request.projectId || context.tenantId;
    const result = await this.service.switchActiveApartment(projectId, this.required(request.residentId, 'resident_id'), this.required(request.apartmentId, 'apartment_id'));
    return { residentId: result.residentId, projectId: result.projectId, apartmentId: result.apartmentId, selectedAt: result.selectedAt.toISOString() };
  }

  @GrpcMethod('PropertyResidentService', 'ListApartmentVehicles')
  async listApartmentVehicles(request: VehicleRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    return { vehicles: await this.service.listApartmentVehicles(context.tenantId, this.required(request.apartmentId, 'apartment_id')) };
  }

  private required(value: string | undefined, name: string): string {
    if (!value || value.length > 128) throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is required` });
    return value;
  }
}
