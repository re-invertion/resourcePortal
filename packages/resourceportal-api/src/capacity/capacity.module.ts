import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CapacityDeploymentAdmissionService } from "./capacity-deployment-admission.service";
import { CapacityPreflightService } from "./capacity-preflight.service";

@Module({
  imports: [PrismaModule],
  providers: [CapacityPreflightService, CapacityDeploymentAdmissionService],
  exports: [CapacityPreflightService, CapacityDeploymentAdmissionService],
})
export class CapacityModule {}
