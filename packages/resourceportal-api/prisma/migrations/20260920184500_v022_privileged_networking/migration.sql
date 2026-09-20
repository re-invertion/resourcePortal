ALTER TABLE "AppGroup"
  ADD COLUMN "networkPrivileged" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "InternalPortExposure" (
  "id" UUID NOT NULL,
  "appGroupId" UUID NOT NULL,
  "singleAppId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "containerPort" INTEGER NOT NULL,
  "publishedPort" INTEGER NOT NULL,
  "protocol" TEXT NOT NULL DEFAULT 'tcp',
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalPortExposure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InternalPortExposure_singleAppId_name_key"
  ON "InternalPortExposure"("singleAppId", "name");
CREATE UNIQUE INDEX "InternalPortExposure_protocol_publishedPort_key"
  ON "InternalPortExposure"("protocol", "publishedPort");
CREATE INDEX "InternalPortExposure_appGroupId_idx"
  ON "InternalPortExposure"("appGroupId");

ALTER TABLE "InternalPortExposure"
  ADD CONSTRAINT "InternalPortExposure_appGroupId_fkey"
  FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InternalPortExposure"
  ADD CONSTRAINT "InternalPortExposure_singleAppId_fkey"
  FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
