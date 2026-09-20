import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";

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

export function deploymentOperationType(
  deployment: Pick<MirroredDeployment, "rollbackTargetVersion">,
): DeploymentOperationType {
  return deployment.rollbackTargetVersion === null
    ? "APP_GROUP_DEPLOY"
    : "APP_GROUP_ROLLBACK";
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
        ${idempotencyKey}, 5, NOW()
      )
      ON CONFLICT DO NOTHING
      RETURNING "id"
    ), event_insert AS (
      INSERT INTO "OperationEvent" (
        "id", "operationId", "phase", "level", "event", "message", "details"
      )
      SELECT
        ${eventId}::uuid, "id", ${deployment.phase}, 'Info',
        'OperationCreated',
        'AppGroup deployment queued for Operation worker execution',
        ${payload}::jsonb
      FROM inserted
      RETURNING "id"
    )
    SELECT "id" FROM inserted
  `);

  return rows[0] ?? null;
}
