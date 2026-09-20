CREATE TABLE "PlatformEgressPolicy" (
  "id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformEgressPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformEgressAllowRule" (
  "id" UUID NOT NULL,
  "appGroupId" UUID NOT NULL,
  "destinationCidr" TEXT NOT NULL,
  "protocol" TEXT NOT NULL DEFAULT 'any',
  "port" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT,
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformEgressAllowRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformEgressAllowRule_scope_key"
  ON "PlatformEgressAllowRule"("appGroupId", "destinationCidr", "protocol", "port");
CREATE INDEX "PlatformEgressAllowRule_appGroupId_idx"
  ON "PlatformEgressAllowRule"("appGroupId");

ALTER TABLE "PlatformEgressAllowRule"
  ADD CONSTRAINT "PlatformEgressAllowRule_appGroupId_fkey"
  FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PlatformEgressPolicy" (
  "id", "enabled", "revision", "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8000-000000000022', true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
