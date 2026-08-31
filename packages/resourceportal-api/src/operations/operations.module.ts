import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DeploymentOperationAdapterService } from "./deployment-operation-adapter.service";
import { OperationEventBus } from "./operation-event-bus";
import { OperationsController } from "./operations.controller";
import { OperationsRepository } from "./operations.repository";
import { OperationsService } from "./operations.service";

@Module({
  imports: [PrismaModule],
  controllers: [OperationsController],
  providers: [
    DeploymentOperationAdapterService,
    OperationEventBus,
    OperationsRepository,
    OperationsService,
  ],
  exports: [
    DeploymentOperationAdapterService,
    OperationEventBus,
    OperationsRepository,
    OperationsService,
  ],
})
export class OperationsModule {}
