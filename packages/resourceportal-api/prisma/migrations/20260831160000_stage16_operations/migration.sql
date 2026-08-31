-- Stage 16 — Operations / Jobs

CREATE TYPE "OperationStatus" AS ENUM (
  'Pending',
  'Running',
  'Succeeded',
  'Failed',
  'RollingBack',
  'RolledBack',
  'RollbackFailed'
);

CREATE TABLE "Operation" (
  "id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "tenantId" UUID,
  "resourceType" TEXT NOT NULL,
  "resourceId" UUID,
  "status" "OperationStatus" NOT NULL DEFAULT 'Pending',
  "phase" TEXT,
  "createdBy" UUID NOT NULL,
  "createdByEmail" TEXT NOT NULL,
  "createdByDisplayName" TEXT NOT NULL,
  "input" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "idempotencyKey" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationEvent" (
  "id" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "phase" TEXT,
  "level" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "details" JSONB,

  CONSTRAINT "OperationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Operation_tenantId_type_idempotencyKey_key"
  ON "Operation"("tenantId", "type", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX "Operation_queue_idx"
  ON "Operation"("status", "nextAttemptAt", "createdAt");

CREATE INDEX "Operation_tenantId_createdAt_idx"
  ON "Operation"("tenantId", "createdAt" DESC);

CREATE INDEX "Operation_resource_idx"
  ON "Operation"("resourceType", "resourceId");

CREATE INDEX "OperationEvent_operationId_timestamp_idx"
  ON "OperationEvent"("operationId", "timestamp");

ALTER TABLE "Operation"
  ADD CONSTRAINT "Operation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OperationEvent"
  ADD CONSTRAINT "OperationEvent_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
