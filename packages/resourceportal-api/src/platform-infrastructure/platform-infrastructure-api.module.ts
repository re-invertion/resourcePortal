import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { CapacityModule } from "../capacity/capacity.module";
import { PrismaModule } from "../prisma/prisma.module";
import { HostMachineResourceUsageService } from "./host-machine-resource-usage.service";
import { NvidiaGpuAllocationService } from "./nvidia-gpu-allocation.service";
import { PlatformInfrastructureController } from "./platform-infrastructure.controller";
import { PlatformReleaseService } from "./platform-release.service";
import { SwarmInfrastructureReadService } from "./swarm-infrastructure-read.service";
import { SwarmInfrastructureStore } from "./swarm-infrastructure.store";

@Module({
  imports: [PrismaModule, OperationsModule, CapacityModule],
  controllers: [PlatformInfrastructureController],
  providers: [
    HostMachineResourceUsageService,
    NvidiaGpuAllocationService,
    PlatformReleaseService,
    SwarmInfrastructureStore,
    SwarmInfrastructureReadService,
  ],
})
export class PlatformInfrastructureApiModule {}
