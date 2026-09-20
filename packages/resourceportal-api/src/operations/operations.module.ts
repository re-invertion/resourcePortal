import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OperationEventBus } from "./operation-event-bus";
import { OperationsController } from "./operations.controller";
import { OperationsRepository } from "./operations.repository";
import { OperationsService } from "./operations.service";

@Module({
  imports: [PrismaModule],
  controllers: [OperationsController],
  providers: [
    OperationEventBus,
    OperationsRepository,
    OperationsService,
  ],
  exports: [
    OperationEventBus,
    OperationsRepository,
    OperationsService,
  ],
})
export class OperationsModule {}
