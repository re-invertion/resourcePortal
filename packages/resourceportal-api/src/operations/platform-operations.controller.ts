import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { OperationsService } from "./operations.service";

@Controller("platform/operations")
@UseGuards(PlatformAdminGuard)
export class PlatformOperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  listOperations() {
    return this.operations.listPlatform();
  }

  @Get(":operationId/events")
  listEvents(
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.eventsPlatform(operationId);
  }

  @Get(":operationId")
  getOperation(
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.getPlatform(operationId);
  }

  @Post(":operationId/retry")
  retryOperation(
    @Param("operationId", ParseUUIDPipe) operationId: string,
  ) {
    return this.operations.retryPlatform(operationId);
  }
}
