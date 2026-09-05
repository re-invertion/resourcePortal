ALTER TABLE "StorageBackend"
  ALTER COLUMN "basePath" SET DEFAULT '/srv/resource-portal/storage',
  ALTER COLUMN "volumeBasePath" SET DEFAULT '/srv/resource-portal/storage/volumes',
  ALTER COLUMN "secretBasePath" SET DEFAULT '/srv/resource-portal/storage/secrets';

UPDATE "StorageBackend"
SET
  "basePath" = '/srv/resource-portal/storage',
  "volumeBasePath" = '/srv/resource-portal/storage/volumes',
  "secretBasePath" = '/srv/resource-portal/storage/secrets',
  "status" = 'Error',
  "health" = 'Unknown',
  "lastValidationError" = 'Storage backend requires Wiki-path validation after migration',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-4000-8000-000000000014'::uuid;
