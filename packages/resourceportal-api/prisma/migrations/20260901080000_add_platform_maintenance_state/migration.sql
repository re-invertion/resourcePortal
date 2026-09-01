CREATE TABLE "PlatformMaintenanceState" (
  "id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "updatedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformMaintenanceState_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformMaintenanceState" (
  "id",
  "enabled",
  "reason",
  "updatedBy",
  "createdAt",
  "updatedAt"
)
VALUES (
  '00000000-0000-4000-8000-000000000019',
  false,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
