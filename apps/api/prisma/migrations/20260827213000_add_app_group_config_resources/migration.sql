ALTER TABLE "Variable" ADD COLUMN "createdBy" UUID;
ALTER TABLE "Variable" ADD COLUMN "updatedBy" TEXT;

UPDATE "Variable"
SET
  "createdBy" = "AppGroup"."createdBy",
  "updatedBy" = "AppGroup"."updatedBy"
FROM "AppGroup"
WHERE "Variable"."appGroupId" = "AppGroup"."id";

ALTER TABLE "Variable" ALTER COLUMN "createdBy" SET NOT NULL;
ALTER TABLE "Variable" ALTER COLUMN "updatedBy" SET NOT NULL;

ALTER TABLE "Config" ADD COLUMN "createdBy" UUID;
ALTER TABLE "Config" ADD COLUMN "updatedBy" TEXT;

UPDATE "Config"
SET
  "createdBy" = "AppGroup"."createdBy",
  "updatedBy" = "AppGroup"."updatedBy"
FROM "AppGroup"
WHERE "Config"."appGroupId" = "AppGroup"."id";

ALTER TABLE "Config" ALTER COLUMN "createdBy" SET NOT NULL;
ALTER TABLE "Config" ALTER COLUMN "updatedBy" SET NOT NULL;

CREATE TABLE "VariableAttachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variableId" UUID NOT NULL,
    "singleAppId" UUID NOT NULL,
    "targetName" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariableAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConfigAttachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "configId" UUID NOT NULL,
    "singleAppId" UUID NOT NULL,
    "targetPath" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VariableAttachment_variableId_singleAppId_key" ON "VariableAttachment"("variableId", "singleAppId");
CREATE UNIQUE INDEX "VariableAttachment_singleAppId_targetName_key" ON "VariableAttachment"("singleAppId", "targetName");
CREATE UNIQUE INDEX "ConfigAttachment_configId_singleAppId_key" ON "ConfigAttachment"("configId", "singleAppId");
CREATE UNIQUE INDEX "ConfigAttachment_singleAppId_targetPath_key" ON "ConfigAttachment"("singleAppId", "targetPath");

ALTER TABLE "VariableAttachment" ADD CONSTRAINT "VariableAttachment_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "Variable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VariableAttachment" ADD CONSTRAINT "VariableAttachment_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfigAttachment" ADD CONSTRAINT "ConfigAttachment_configId_fkey" FOREIGN KEY ("configId") REFERENCES "Config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConfigAttachment" ADD CONSTRAINT "ConfigAttachment_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
