import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DeploymentOperationAdapterService } from "./deployment-operation-adapter.service";
import { OperationsController } from "./operations.controller";
import { OperationsRepository } from "./operations.repository";
import { OperationsService } from "./operations.service";

@Module({
  imports: [PrismaModule],
  controllers: [OperationsController],
  providers: [
    DeploymentOperationAdapterService,
    OperationsRepository,
    OperationsService,
  ],
  exports: [
    DeploymentOperationAdapterService,
    OperationsRepository,
    OperationsService,
  ],
})
export class OperationsModule {}
