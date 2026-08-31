import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import type { OperationStatus } from "./operation.types";
import { OperationsRepository } from "./operations.repository";

export type DeploymentOperationType =
  | "APP_GROUP_DEPLOY"
  | "APP_GROUP_ROLLBACK";

type MirroredDeployment = {
  id: string;
  appGroupId: string;
  version: number;
  phase: string;
  correlationId: string;
  rollbackTargetVersion: number | null;
};

type DeploymentOutcome = {
  id: string;
  version: number;
  status: string;
  phase: string;
  rollbackTargetVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type MirroredOperationRef = {
  id: string;
  type: DeploymentOperationType;
};

export function deploymentOperationType(
  deployment: Pick<MirroredDeployment, "rollbackTargetVersion">,
): DeploymentOperationType {
  return deployment.rollbackTargetVersion === null
    ? "APP_GROUP_DEPLOY"
    : "APP_GROUP_ROLLBACK";
}

export function mapDeploymentOperationStatus(
  deploymentStatus: string,
  operationType: DeploymentOperationType,
): OperationStatus {
  switch (deploymentStatus) {
    case "Pending":
      return "Pending";
    case "Deploying":
      return "Running";
    case "RollingBack":
      return "RollingBack";
    case "Succeeded":
      return operationType === "APP_GROUP_ROLLBACK"
        ? "RolledBack"
        : "Succeeded";
    case "Failed":
      return "Failed";
    case "RolledBack":
      return "RolledBack";
    case "RollbackFailed":
      return "RollbackFailed";
    default:
      return "Failed";
  }
}

export async function mirrorDeploymentOperation(
  tx: Prisma.TransactionClient,
  deployment: MirroredDeployment,
  tenantId: string,
  actor: Pick<AuthenticatedUser, "id" | "email" | "displayName">,
) {
  const operationType = deploymentOperationType(deployment);
  const operationId = deployment.id;
  const eventId = randomUUID();
  const payload = JSON.stringify({
    deploymentId: deployment.id,
    appGroupId: deployment.appGroupId,
    version: deployment.version,
    rollbackTargetVersion: deployment.rollbackTargetVersion,
    correlationId: deployment.correlationId,
  });
  const idempotencyKey = `deployment:${deployment.id}`;

  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH inserted AS (
      INSERT INTO "Operation" (
        "id", "type", "tenantId", "resourceType", "resourceId",
        "status", "phase", "createdBy", "createdByEmail",
        "createdByDisplayName", "input", "idempotencyKey", "maxAttempts",
        "nextAttemptAt"
      ) VALUES (
        ${operationId}::uuid, ${operationType}, ${tenantId}::uuid,
        'AppGroupDeployment', ${deployment.id}::uuid,
        'Pending'::"OperationStatus", ${deployment.phase}, ${actor.id}::uuid,
        ${actor.email}, ${actor.displayName}, ${payload}::jsonb,
        ${idempotencyKey}, 1, NOW()
      )
      ON CONFLICT ("id") DO NOTHING
      RETURNING "id"
    ), event_insert AS (
      INSERT INTO "OperationEvent" (
        "id", "operationId", "phase", "level", "event", "message", "details"
      )
      SELECT
        ${eventId}::uuid, "id", ${deployment.phase}, 'Info',
        'OperationCreated',
        'AppGroup deployment mirrored into Operations',
        ${payload}::jsonb
      FROM inserted
      RETURNING "id"
    )
    SELECT "id" FROM inserted
  `);

  return rows[0] ?? null;
}

@Injectable()
export class DeploymentOperationAdapterService {
  constructor(
    private readonly repository: OperationsRepository,
    private readonly prisma: PrismaService,
  ) {}

  mirrorCreatedDeployment(
    tx: Prisma.TransactionClient,
    deployment: MirroredDeployment,
    tenantId: string,
    actor: Pick<AuthenticatedUser, "id" | "email" | "displayName">,
  ) {
    return mirrorDeploymentOperation(tx, deployment, tenantId, actor);
  }

  async syncDeploymentOutcome(deployment: DeploymentOutcome) {
    const rows = await this.prisma.$queryRaw<MirroredOperationRef[]>(Prisma.sql`
      SELECT "id", "type"
      FROM "Operation"
      WHERE "resourceType" = 'AppGroupDeployment'
        AND "resourceId" = ${deployment.id}::uuid
        AND "type" IN ('APP_GROUP_DEPLOY', 'APP_GROUP_ROLLBACK')
      LIMIT 1
    `);
    const mirrored = rows[0];
    if (!mirrored) {
      return null;
    }

    const status = mapDeploymentOperationStatus(
      deployment.status,
      mirrored.type,
    );
    const result = {
      deploymentId: deployment.id,
      version: deployment.version,
      rollbackTargetVersion: deployment.rollbackTargetVersion,
      deploymentStatus: deployment.status,
    };
    const operation = await this.repository.syncMirroredOperation(
      mirrored.id,
      status,
      deployment.phase,
      deployment.errorCode,
      deployment.errorMessage,
      result,
    );

    if (operation) {
      await this.repository.appendEvent(mirrored.id, {
        phase: deployment.phase,
        level:
          status === "Failed" || status === "RollbackFailed"
            ? "Error"
            : "Info",
        event: "DeploymentOutcomeSynchronized",
        message: `Deployment state synchronized as ${status}`,
        details: result,
      });
    }

    return operation;
  }
}
