import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { DockerSwarmInfrastructureService } from "./docker-swarm-infrastructure.service";
import { SwarmInfrastructureAuditService } from "./swarm-infrastructure-audit.service";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";
import { SwarmInfrastructureStore } from "./swarm-infrastructure.store";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [
    DockerSwarmInfrastructureService,
    SwarmInfrastructureAuditService,
    SwarmInfrastructureService,
    SwarmInfrastructureStore,
  ],
  exports: [SwarmInfrastructureService],
})
export class PlatformInfrastructureModule {}
