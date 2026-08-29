ALTER TABLE "AppGroupDeployment" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "AppGroupDeployment_appGroupId_idempotencyKey_key"
ON "AppGroupDeployment"("appGroupId", "idempotencyKey");

CREATE UNIQUE INDEX "AppGroupDeployment_one_active_per_app_group_idx"
ON "AppGroupDeployment"("appGroupId")
WHERE "status" IN ('Pending', 'Deploying', 'RollingBack');
