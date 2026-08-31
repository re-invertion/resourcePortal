import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { OperationsService } from "./operations.service";

@Controller("tenants/:tenantId/operations")
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @RequirePermissions("operation.read")
  @Get()
  listOperations(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.operations.list(tenantId);
  }

  @RequirePermissions("operation.read")
  @Get(":operationId/events")
  listEvents(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.events(tenantId, operationId);
  }

  @RequirePermissions("operation.read")
  @Get(":operationId")
  getOperation(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.get(tenantId, operationId);
  }

  @RequirePermissions("operation.retry")
  @Post(":operationId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  retryOperation(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.retry(tenantId, operationId);
  }
}
