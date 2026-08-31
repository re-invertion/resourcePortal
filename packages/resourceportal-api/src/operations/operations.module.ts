import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OperationsController } from "./operations.controller";
import { OperationsRepository } from "./operations.repository";
import { OperationsService } from "./operations.service";

@Module({
  imports: [PrismaModule],
  controllers: [OperationsController],
  providers: [OperationsRepository, OperationsService],
  exports: [OperationsRepository, OperationsService],
})
export class OperationsModule {}
