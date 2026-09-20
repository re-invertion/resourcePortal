-- ResourcePortal v0.2.0 runtime architecture.
-- Additive migration to preserve upgrades from v0.1.8/v0.1.9/v0.1.10.

ALTER TABLE "Secret"
  ADD COLUMN IF NOT EXISTS "keyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "valueCiphertext" TEXT;

ALTER TABLE "Secret"
  ALTER COLUMN "storagePath" DROP NOT NULL;

-- AppGroupDeployment remains as deployment history/snapshot data for compatibility.
-- Operation is the execution queue in v0.2.0; existing deployment lease columns are
-- intentionally retained so rolling upgrades and old snapshots remain readable.
-- PostgreSQL treats NULL values as distinct in normal unique indexes, so the
-- Stage 16 (tenantId,type,idempotencyKey) index does not protect platform-
-- scoped Operations where tenantId is NULL. Preserve historical rows but clear
-- the duplicate key from later duplicates before adding the new invariant.
WITH ranked_global_operations AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "type", "idempotencyKey"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "Operation"
  WHERE "tenantId" IS NULL AND "idempotencyKey" IS NOT NULL
)
UPDATE "Operation" AS operation
SET "idempotencyKey" = NULL
FROM ranked_global_operations AS ranked
WHERE operation."id" = ranked."id"
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Operation_global_type_idempotencyKey_key"
  ON "Operation"("type", "idempotencyKey")
  WHERE "tenantId" IS NULL AND "idempotencyKey" IS NOT NULL;

