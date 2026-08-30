import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DockerSwarmInfrastructureService } from "./docker-swarm-infrastructure.service";
import { PlatformInfrastructureController } from "./platform-infrastructure.controller";
import { SwarmInfrastructureReconcilerService } from "./swarm-infrastructure-reconciler.service";
import { SwarmInfrastructureAuditService } from "./swarm-infrastructure-audit.service";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";
import { SwarmInfrastructureStore } from "./swarm-infrastructure.store";

@Module({
  imports: [PrismaModule],
  controllers: [PlatformInfrastructureController],
  providers: [
    DockerSwarmInfrastructureService,
    SwarmInfrastructureAuditService,
    SwarmInfrastructureReconcilerService,
    SwarmInfrastructureService,
    SwarmInfrastructureStore,
  ],
  exports: [SwarmInfrastructureService],
})
export class PlatformInfrastructureModule {}
