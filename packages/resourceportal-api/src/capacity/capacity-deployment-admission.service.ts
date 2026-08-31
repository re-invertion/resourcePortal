import { Injectable } from "@nestjs/common";
import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CapacityPreflightService,
  type CapacityDeploymentSnapshot,
} from "./capacity-preflight.service";

type DeploymentForAdmission = {
  id: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
};

@Injectable()
export class CapacityDeploymentAdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preflight: CapacityPreflightService,
  ) {}

  admitAndAdvance(
    deployment: DeploymentForAdmission,
    snapshot: CapacityDeploymentSnapshot,
    message?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const admission = await this.preflight.admitDeployment(tx, snapshot);
      if (!admission.success) {
        return admission;
      }

      const next = await tx.appGroupDeployment.update({
        where: { id: deployment.id },
        data: {
          phase: DeploymentPhase.PreparingArtifacts,
          status: DeploymentStatus.Deploying,
          leaseOwner: deployment.leaseOwner,
          leaseExpiresAt: deployment.leaseExpiresAt,
          heartbeatAt: new Date(),
        },
      });

      await tx.deploymentEvent.create({
        data: {
          deploymentId: deployment.id,
          phase: DeploymentPhase.PreparingArtifacts,
          level: "Info",
          message: message ?? "Deployment advanced to PreparingArtifacts",
        },
      });

      return {
        success: true as const,
        deployment: next,
        demand: admission.demand,
        occupied: admission.occupied,
        supply: admission.supply,
      };
    });
  }
}
