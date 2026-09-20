-- Durable worker/reconciliation observability. The Worker has no public HTTP
-- listener, so API metrics and diagnostics read these heartbeats from Postgres.
CREATE TABLE IF NOT EXISTS "WorkerRuntimeState" (
  "workerId" VARCHAR(128) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Starting',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoopAt" TIMESTAMP(3),
  "lastOperationId" UUID,
  "lastOperationStatus" TEXT,
  "lastOperationAt" TIMESTAMP(3),
  "lastError" TEXT,
  "stoppedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerRuntimeState_pkey" PRIMARY KEY ("workerId")
);

CREATE INDEX IF NOT EXISTS "WorkerRuntimeState_heartbeatAt_idx"
  ON "WorkerRuntimeState"("heartbeatAt");

CREATE TABLE IF NOT EXISTS "WorkerReconciliationState" (
  "workerId" VARCHAR(128) NOT NULL,
  "key" VARCHAR(64) NOT NULL,
  "lastStartedAt" TIMESTAMP(3),
  "lastCompletedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastDurationMs" INTEGER,
  "lastResult" JSONB,
  "lastError" TEXT,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerReconciliationState_pkey" PRIMARY KEY ("workerId", "key"),
  CONSTRAINT "WorkerReconciliationState_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "WorkerRuntimeState"("workerId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "WorkerReconciliationState_lastFailureAt_idx"
  ON "WorkerReconciliationState"("lastFailureAt");
