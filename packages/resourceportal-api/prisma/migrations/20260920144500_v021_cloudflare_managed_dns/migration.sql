CREATE TABLE "PlatformDnsIntegration" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'Cloudflare',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "zoneId" TEXT,
  "zoneName" TEXT,
  "apiTokenCiphertext" TEXT,
  "lastValidatedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "updatedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformDnsIntegration_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformDnsIntegration" (
  "id",
  "provider",
  "enabled",
  "createdAt",
  "updatedAt"
)
VALUES (
  '00000000-0000-4000-8000-000000000021',
  'Cloudflare',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
