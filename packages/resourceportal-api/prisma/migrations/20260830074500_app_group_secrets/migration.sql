CREATE TYPE "SecretType" AS ENUM ('Text', 'Binary');

ALTER TABLE "Secret"
ADD COLUMN "createdBy" UUID,
ADD COLUMN "updatedBy" TEXT;

UPDATE "Secret" AS secret
SET
  "createdBy" = app_group."createdBy",
  "updatedBy" = app_group."updatedBy"
FROM "AppGroup" AS app_group
WHERE app_group."id" = secret."appGroupId";

ALTER TABLE "Secret"
ALTER COLUMN "createdBy" SET NOT NULL,
ALTER COLUMN "updatedBy" SET NOT NULL,
ALTER COLUMN "type" TYPE "SecretType"
USING CASE
  WHEN "type" = 'Binary' THEN 'Binary'::"SecretType"
  ELSE 'Text'::"SecretType"
END;

CREATE TABLE "SecretAttachment" (
  "id" UUID NOT NULL,
  "secretId" UUID NOT NULL,
  "singleAppId" UUID NOT NULL,
  "targetName" TEXT NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SecretAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SecretAttachment_secretId_singleAppId_key"
ON "SecretAttachment"("secretId", "singleAppId");

CREATE UNIQUE INDEX "SecretAttachment_singleAppId_targetName_key"
ON "SecretAttachment"("singleAppId", "targetName");

ALTER TABLE "SecretAttachment"
ADD CONSTRAINT "SecretAttachment_secretId_fkey"
FOREIGN KEY ("secretId") REFERENCES "Secret"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SecretAttachment"
ADD CONSTRAINT "SecretAttachment_singleAppId_fkey"
FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
