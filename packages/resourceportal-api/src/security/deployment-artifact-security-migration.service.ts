import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "./encryption.service";
import {
  hasProtectedSensitiveEnvironment,
  protectDeploymentStackConfig,
} from "./sensitive-environment";

const ACTIVE_DEPLOYMENTS = new Set<DeploymentStatus>([
  DeploymentStatus.Pending,
  DeploymentStatus.Deploying,
  DeploymentStatus.RollingBack,
]);

@Injectable()
export class DeploymentArtifactSecurityMigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async migrateAll() {
    const deployments = await this.prisma.appGroupDeployment.findMany({
      where: { stackConfig: { not: null } },
      select: {
        id: true,
        status: true,
        stackConfig: true,
        renderedStack: true,
      },
    });

    let migrated = 0;
    let protectedValues = 0;
    let failed = 0;

    for (const deployment of deployments) {
      if (!deployment.stackConfig || ACTIVE_DEPLOYMENTS.has(deployment.status)) {
        continue;
      }
      try {
        const protectedConfig = protectDeploymentStackConfig(
          deployment.stackConfig,
          this.encryption,
        );
        const alreadyProtected = hasProtectedSensitiveEnvironment(
          deployment.stackConfig,
        );
        const mustClearRenderedStack =
          protectedConfig.protectedValues > 0 ||
          (alreadyProtected && deployment.renderedStack !== null);
        if (protectedConfig.protectedValues === 0 && !mustClearRenderedStack) {
          continue;
        }

        await this.prisma.appGroupDeployment.update({
          where: { id: deployment.id },
          data: {
            stackConfig: protectedConfig.stackConfig,
            renderedStack: mustClearRenderedStack ? null : undefined,
            renderedStackSha256: mustClearRenderedStack ? null : undefined,
            renderedAt: mustClearRenderedStack ? null : undefined,
          },
        });
        migrated += 1;
        protectedValues += protectedConfig.protectedValues;
      } catch {
        failed += 1;
      }
    }

    return { scanned: deployments.length, migrated, protectedValues, failed };
  }
}
