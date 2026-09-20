import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformInfrastructureController } from "./platform-infrastructure.controller";
import { SwarmInfrastructureReadService } from "./swarm-infrastructure-read.service";
import { SwarmInfrastructureStore } from "./swarm-infrastructure.store";

@Module({
  imports: [PrismaModule, OperationsModule],
  controllers: [PlatformInfrastructureController],
  providers: [SwarmInfrastructureStore, SwarmInfrastructureReadService],
})
export class PlatformInfrastructureApiModule {}
