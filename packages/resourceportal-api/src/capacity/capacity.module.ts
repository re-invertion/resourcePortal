import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CapacityDeploymentAdmissionService } from "./capacity-deployment-admission.service";
import { CapacityPolicyService } from "./capacity-policy.service";
import { CapacityPreflightService } from "./capacity-preflight.service";
import { CapacityTelemetryService } from "./capacity-telemetry.service";
import { CapacityTelemetryStore } from "./capacity-telemetry.store";
import { SwarmCapacityNodeProbeRouter } from "./swarm-capacity-node-probe-router";

@Module({
  imports: [PrismaModule],
  providers: [
    CapacityPolicyService,
    CapacityTelemetryStore,
    SwarmCapacityNodeProbeRouter,
    CapacityTelemetryService,
    CapacityPreflightService,
    CapacityDeploymentAdmissionService,
  ],
  exports: [
    CapacityPolicyService,
    CapacityTelemetryStore,
    SwarmCapacityNodeProbeRouter,
    CapacityTelemetryService,
    CapacityPreflightService,
    CapacityDeploymentAdmissionService,
  ],
})
export class CapacityModule {}
