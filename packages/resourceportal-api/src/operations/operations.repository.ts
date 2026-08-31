import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import {
  AppendOperationEventInput,
  CreateOperationInput,
  OperationEventRecord,
  OperationRecord,
  OperationStatus,
} from "./operation.types";

@Injectable()
export class OperationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createOperation(input: CreateOperationInput) {
    const id = randomUUID();
    const eventId = randomUUID();
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 5));
    const resourceId = input.resourceId ?? null;
    const phase = input.phase ?? null;
    const payload = JSON.stringify(input.input ?? {});
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    const rows = idempotencyKey
      ? await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
          WITH inserted AS (
            INSERT INTO "Operation" (
              "id", "type", "tenantId", "resourceType", "resourceId",
              "status", "phase", "createdBy", "createdByEmail",
              "createdByDisplayName", "input", "idempotencyKey",
              "maxAttempts", "nextAttemptAt"
            ) VALUES (
              ${id}::uuid, ${input.type}, ${input.tenantId}::uuid,
              ${input.resourceType}, ${resourceId}::uuid,
              'Pending'::"OperationStatus", ${phase}, ${input.createdBy}::uuid,
              ${input.createdByEmail}, ${input.createdByDisplayName},
              ${payload}::jsonb, ${idempotencyKey}, ${maxAttempts}, NOW()
            )
            ON CONFLICT ("tenantId", "type", "idempotencyKey")
              WHERE "idempotencyKey" IS NOT NULL
            DO NOTHING
            RETURNING *
          ), selected AS (
            SELECT * FROM inserted
            UNION ALL
            SELECT *
            FROM "Operation"
            WHERE "tenantId" = ${input.tenantId}::uuid
              AND "type" = ${input.type}
              AND "idempotencyKey" = ${idempotencyKey}
              AND NOT EXISTS (SELECT 1 FROM inserted)
            LIMIT 1
          ), event_insert AS (
            INSERT INTO "OperationEvent" (
              "id", "operationId", "phase", "level", "event", "message", "details"
            )
            SELECT
              ${eventId}::uuid, "id", "phase", 'Info', 'OperationCreated',
              'Operation accepted and queued for worker execution', NULL
            FROM inserted
            RETURNING "id"
          )
          SELECT * FROM selected
        `)
      : await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
          WITH inserted AS (
            INSERT INTO "Operation" (
              "id", "type", "tenantId", "resourceType", "resourceId",
              "status", "phase", "createdBy", "createdByEmail",
              "createdByDisplayName", "input", "idempotencyKey",
              "maxAttempts", "nextAttemptAt"
            ) VALUES (
              ${id}::uuid, ${input.type}, ${input.tenantId}::uuid,
              ${input.resourceType}, ${resourceId}::uuid,
              'Pending'::"OperationStatus", ${phase}, ${input.createdBy}::uuid,
              ${input.createdByEmail}, ${input.createdByDisplayName},
              ${payload}::jsonb, NULL, ${maxAttempts}, NOW()
            )
            RETURNING *
          ), event_insert AS (
            INSERT INTO "OperationEvent" (
              "id", "operationId", "phase", "level", "event", "message", "details"
            )
            SELECT
              ${eventId}::uuid, "id", "phase", 'Info', 'OperationCreated',
              'Operation accepted and queued for worker execution', NULL
            FROM inserted
            RETURNING "id"
          )
          SELECT * FROM inserted
        `);

    const operation = rows[0];
    if (!operation) {
      throw new Error("Operation could not be created or resolved idempotently");
    }

    return operation;
  }

  async listOperations(tenantId: string, limit = 100) {
    const safeLimit = Math.min(250, Math.max(1, Math.floor(limit)));
    return this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      SELECT *
      FROM "Operation"
      WHERE "tenantId" = ${tenantId}::uuid
      ORDER BY "createdAt" DESC
      LIMIT ${safeLimit}
    `);
  }

  async getOperation(tenantId: string, operationId: string) {
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      SELECT *
      FROM "Operation"
      WHERE "id" = ${operationId}::uuid
        AND "tenantId" = ${tenantId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async getOperationById(operationId: string) {
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      SELECT *
      FROM "Operation"
      WHERE "id" = ${operationId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  listEvents(operationId: string) {
    return this.prisma.$queryRaw<OperationEventRecord[]>(Prisma.sql`
      SELECT *
      FROM "OperationEvent"
      WHERE "operationId" = ${operationId}::uuid
      ORDER BY "timestamp" ASC, "id" ASC
    `);
  }

  async appendEvent(operationId: string, input: AppendOperationEventInput) {
    const details = input.details === undefined ? null : JSON.stringify(input.details);
    const rows = await this.prisma.$queryRaw<OperationEventRecord[]>(Prisma.sql`
      INSERT INTO "OperationEvent" (
        "id", "operationId", "phase", "level", "event", "message", "details"
      ) VALUES (
        ${randomUUID()}::uuid, ${operationId}::uuid, ${input.phase ?? null},
        ${input.level ?? "Info"}, ${input.event}, ${input.message},
        ${details}::jsonb
      )
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async claimNext(workerId: string, leaseSeconds: number) {
    const safeLeaseSeconds = Math.max(15, Math.floor(leaseSeconds));
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "Operation"
        WHERE "type" NOT IN ('APP_GROUP_DEPLOY', 'APP_GROUP_ROLLBACK')
          AND (
            ("status" = 'Pending'::"OperationStatus" AND "nextAttemptAt" <= NOW())
            OR (
              "status" = 'Running'::"OperationStatus"
              AND "leaseExpiresAt" IS NOT NULL
              AND "leaseExpiresAt" <= NOW()
            )
          )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "Operation" AS operation
      SET
        "status" = 'Running'::"OperationStatus",
        "attempt" = operation."attempt" + 1,
        "leaseOwner" = ${workerId},
        "leaseExpiresAt" = NOW() + (${safeLeaseSeconds} * INTERVAL '1 second'),
        "heartbeatAt" = NOW(),
        "startedAt" = COALESCE(operation."startedAt", NOW()),
        "completedAt" = NULL
      FROM candidate
      WHERE operation."id" = candidate."id"
      RETURNING operation.*
    `);

    const operation = rows[0] ?? null;
    if (operation) {
      await this.appendEvent(operation.id, {
        phase: operation.phase,
        event: "OperationClaimed",
        message: `Operation claimed by worker ${workerId}`,
        details: { attempt: operation.attempt, workerId },
      });
    }
    return operation;
  }

  async heartbeat(operationId: string, workerId: string, leaseSeconds: number) {
    const safeLeaseSeconds = Math.max(15, Math.floor(leaseSeconds));
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "heartbeatAt" = NOW(),
        "leaseExpiresAt" = NOW() + (${safeLeaseSeconds} * INTERVAL '1 second')
      WHERE "id" = ${operationId}::uuid
        AND "status" = 'Running'::"OperationStatus"
        AND "leaseOwner" = ${workerId}
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async markSucceeded(
    operationId: string,
    workerId: string,
    result: unknown,
    resourceId?: string | null,
  ) {
    const serializedResult = result === undefined ? null : JSON.stringify(result);
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "status" = 'Succeeded'::"OperationStatus",
        "result" = ${serializedResult}::jsonb,
        "resourceId" = COALESCE(${resourceId ?? null}::uuid, "resourceId"),
        "errorCode" = NULL,
        "errorMessage" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NOW(),
        "completedAt" = NOW()
      WHERE "id" = ${operationId}::uuid
        AND "status" = 'Running'::"OperationStatus"
        AND "leaseOwner" = ${workerId}
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async markFailed(
    operationId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
    status: Extract<OperationStatus, "Failed" | "RollbackFailed"> = "Failed",
  ) {
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "status" = ${status}::"OperationStatus",
        "errorCode" = ${errorCode},
        "errorMessage" = ${errorMessage},
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NOW(),
        "completedAt" = NOW()
      WHERE "id" = ${operationId}::uuid
        AND "leaseOwner" = ${workerId}
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async scheduleRetry(
    operationId: string,
    workerId: string,
    nextAttemptAt: Date,
    errorCode: string,
    errorMessage: string,
  ) {
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "status" = 'Pending'::"OperationStatus",
        "nextAttemptAt" = ${nextAttemptAt},
        "errorCode" = ${errorCode},
        "errorMessage" = ${errorMessage},
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NOW(),
        "completedAt" = NULL
      WHERE "id" = ${operationId}::uuid
        AND "leaseOwner" = ${workerId}
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async retryFailedOperation(tenantId: string, operationId: string) {
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "status" = 'Pending'::"OperationStatus",
        "attempt" = 0,
        "nextAttemptAt" = NOW(),
        "errorCode" = NULL,
        "errorMessage" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NULL,
        "startedAt" = NULL,
        "completedAt" = NULL
      WHERE "id" = ${operationId}::uuid
        AND "tenantId" = ${tenantId}::uuid
        AND "status" IN (
          'Failed'::"OperationStatus",
          'RollbackFailed'::"OperationStatus"
        )
      RETURNING *
    `);
    return rows[0] ?? null;
  }

  async syncMirroredOperation(
    operationId: string,
    status: OperationStatus,
    phase: string | null,
    errorCode: string | null,
    errorMessage: string | null,
    result: unknown,
  ) {
    const serializedResult = result === undefined ? null : JSON.stringify(result);
    const terminal = [
      "Succeeded",
      "Failed",
      "RolledBack",
      "RollbackFailed",
    ].includes(status);
    const rows = await this.prisma.$queryRaw<OperationRecord[]>(Prisma.sql`
      UPDATE "Operation"
      SET
        "status" = ${status}::"OperationStatus",
        "phase" = ${phase},
        "errorCode" = ${errorCode},
        "errorMessage" = ${errorMessage},
        "result" = ${serializedResult}::jsonb,
        "startedAt" = CASE
          WHEN ${status}::"OperationStatus" <> 'Pending'::"OperationStatus"
          THEN COALESCE("startedAt", NOW())
          ELSE "startedAt"
        END,
        "completedAt" = CASE WHEN ${terminal} THEN NOW() ELSE NULL END
      WHERE "id" = ${operationId}::uuid
      RETURNING *
    `);
    return rows[0] ?? null;
  }
}
