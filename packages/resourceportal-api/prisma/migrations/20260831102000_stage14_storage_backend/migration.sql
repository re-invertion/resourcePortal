-- Stage 14: platform StorageBackend backed by CephFS.

CREATE TABLE "StorageBackend" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'CephFS',
  "basePath" TEXT NOT NULL DEFAULT '/rp',
  "volumeBasePath" TEXT NOT NULL DEFAULT '/rp/volumes',
  "secretBasePath" TEXT NOT NULL DEFAULT '/rp/secrets',
  "status" TEXT NOT NULL DEFAULT 'Error',
  "health" TEXT NOT NULL DEFAULT 'Unknown',
  "maintenance" BOOLEAN NOT NULL DEFAULT false,
  "capacityTotal" BIGINT,
  "capacityAvailable" BIGINT,
  "lastValidatedAt" TIMESTAMP(3),
  "lastValidationError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorageBackend_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StorageBackend_type_check" CHECK ("type" IN ('CephFS')),
  CONSTRAINT "StorageBackend_status_check" CHECK ("status" IN ('Ready', 'Error')),
  CONSTRAINT "StorageBackend_health_check" CHECK ("health" IN ('Healthy', 'Degraded', 'Unhealthy', 'Unknown')),
  CONSTRAINT "StorageBackend_capacity_check" CHECK (
    ("capacityTotal" IS NULL OR "capacityTotal" >= 0) AND
    ("capacityAvailable" IS NULL OR "capacityAvailable" >= 0) AND
    ("capacityTotal" IS NULL OR "capacityAvailable" IS NULL OR "capacityAvailable" <= "capacityTotal")
  )
);

CREATE UNIQUE INDEX "StorageBackend_name_key" ON "StorageBackend"("name");
CREATE INDEX "StorageBackend_status_health_idx" ON "StorageBackend"("status", "health");

INSERT INTO "StorageBackend" (
  "id", "name", "type", "basePath", "volumeBasePath", "secretBasePath",
  "status", "health", "maintenance", "createdAt", "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000014'::uuid,
  'default-cephfs',
  'CephFS',
  '/rp',
  '/rp/volumes',
  '/rp/secrets',
  'Error',
  'Unknown',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

ALTER TABLE "Volume"
  ADD COLUMN "storageBackendId" UUID NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000014'::uuid,
  ADD COLUMN "pendingSizeBytes" BIGINT;

ALTER TABLE "Volume"
  ADD CONSTRAINT "Volume_pendingSizeBytes_check"
  CHECK ("pendingSizeBytes" IS NULL OR "pendingSizeBytes" >= "sizeBytes");

CREATE INDEX "Volume_storageBackendId_idx" ON "Volume"("storageBackendId");
CREATE INDEX "Volume_storageBackend_pendingSize_idx"
  ON "Volume"("storageBackendId", "pendingSizeBytes")
  WHERE "pendingSizeBytes" IS NOT NULL;

ALTER TABLE "Volume"
  ADD CONSTRAINT "Volume_storageBackendId_fkey"
  FOREIGN KEY ("storageBackendId") REFERENCES "StorageBackend"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
