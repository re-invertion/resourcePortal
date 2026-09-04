-- Replace the Stage 14 CephFS metadata contract with the v1 LocalFilesystem contract.
-- This migration changes control-plane metadata only; it does not copy persistent data
-- from a previous CephFS deployment into STORAGE_MOUNT_ROOT.

ALTER TYPE "StorageBackendType" RENAME VALUE 'CephFS' TO 'LocalFilesystem';

ALTER TABLE "StorageBackend"
  ALTER COLUMN "type" SET DEFAULT 'LocalFilesystem';

UPDATE "StorageBackend"
SET
  "name" = 'default-local-filesystem',
  "type" = 'LocalFilesystem',
  "status" = 'Error',
  "health" = 'Unknown',
  "capacityTotal" = NULL,
  "capacityAvailable" = NULL,
  "lastValidatedAt" = NULL,
  "lastValidationError" = 'Storage backend requires LocalFilesystem validation after migration',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-4000-8000-000000000014'::uuid;

CREATE SEQUENCE "Volume_storageProjectId_seq"
  AS INTEGER
  START WITH 10000
  MINVALUE 1
  MAXVALUE 2147483647
  NO CYCLE;

ALTER TABLE "Volume"
  ADD COLUMN "storageProjectId" INTEGER;

UPDATE "Volume"
SET "storageProjectId" = nextval('"Volume_storageProjectId_seq"');

ALTER TABLE "Volume"
  ALTER COLUMN "storageProjectId" SET NOT NULL;

ALTER TABLE "Volume"
  ADD CONSTRAINT "Volume_storageProjectId_check"
  CHECK ("storageProjectId" > 0);

CREATE UNIQUE INDEX "Volume_storageProjectId_key"
  ON "Volume"("storageProjectId");

ALTER SEQUENCE "Volume_storageProjectId_seq"
  OWNED BY "Volume"."storageProjectId";
