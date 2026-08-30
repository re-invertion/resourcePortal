-- Stage 10: prepaid pay-as-you-go billing.

ALTER TABLE "BillingAccount"
  ALTER COLUMN "balance" TYPE DECIMAL(24,8),
  ALTER COLUMN "informationThreshold" TYPE DECIMAL(24,8);

ALTER TABLE "BillingTransaction"
  ALTER COLUMN "amount" TYPE DECIMAL(24,8),
  ALTER COLUMN "balanceBefore" TYPE DECIMAL(24,8),
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(24,8),
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "sourceTransactionId" UUID,
  ADD COLUMN "metadata" JSONB;

CREATE TABLE "PriceListVersion" (
  "id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "cpuCreditsPerVcpuHour" DECIMAL(24,8) NOT NULL,
  "memoryCreditsPerGbHour" DECIMAL(24,8) NOT NULL,
  "storageCreditsPerGbHour" DECIMAL(24,8) NOT NULL,
  "gpuCreditsPerGpuHour" DECIMAL(24,8) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceListVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceListVersion_version_key" ON "PriceListVersion"("version");
CREATE UNIQUE INDEX "PriceListVersion_effectiveFrom_key" ON "PriceListVersion"("effectiveFrom");
CREATE INDEX "PriceListVersion_effectiveFrom_idx" ON "PriceListVersion"("effectiveFrom" DESC);

CREATE TABLE "Voucher" (
  "id" UUID NOT NULL,
  "codeHash" TEXT NOT NULL,
  "valueCredits" DECIMAL(24,8) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "expiresAt" TIMESTAMP(3),
  "redeemedAt" TIMESTAMP(3),
  "redeemedByUserId" UUID,
  "redeemedBillingAccountId" UUID,
  "disabledAt" TIMESTAMP(3),
  "disabledByUserId" UUID,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Voucher_redeemedBillingAccountId_fkey"
    FOREIGN KEY ("redeemedBillingAccountId") REFERENCES "BillingAccount"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Voucher_codeHash_key" ON "Voucher"("codeHash");
CREATE INDEX "Voucher_status_expiresAt_idx" ON "Voucher"("status", "expiresAt");

ALTER TABLE "UsageRecord"
  ALTER COLUMN "cost" TYPE DECIMAL(24,8),
  ADD COLUMN "chargedCredits" DECIMAL(24,8) NOT NULL DEFAULT 0,
  ADD COLUMN "priceListVersionId" UUID,
  ADD COLUMN "appGroupId" UUID,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "UsageRecord"
  ADD CONSTRAINT "UsageRecord_priceListVersionId_fkey"
  FOREIGN KEY ("priceListVersionId") REFERENCES "PriceListVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "UsageRecord_resource_period_key"
  ON "UsageRecord"("resourceType", "resourceId", "periodStart", "periodEnd");
CREATE INDEX "UsageRecord_tenant_period_idx" ON "UsageRecord"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "BillingTransaction_account_created_idx" ON "BillingTransaction"("billingAccountId", "createdAt" DESC, "id" DESC);

CREATE TABLE "BillingWorkerState" (
  "id" TEXT NOT NULL,
  "lastCompletedPeriodEnd" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingWorkerState_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PriceListVersion" (
  "id",
  "version",
  "effectiveFrom",
  "cpuCreditsPerVcpuHour",
  "memoryCreditsPerGbHour",
  "storageCreditsPerGbHour",
  "gpuCreditsPerGpuHour",
  "createdBy"
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  1,
  '2026-08-30T00:00:00.000Z',
  0.50,
  0.25,
  0.025,
  60.00,
  'system-bootstrap'
);
