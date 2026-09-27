CREATE TABLE "TenantResourceBotSettings" (
    "tenantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantResourceBotSettings_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "PlatformResourceBotSettings" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL DEFAULT 'OpenAI',
    "generationModel" TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "apiKeyCiphertext" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformResourceBotSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceBotKnowledgeEmbedding" (
    "id" UUID NOT NULL,
    "corpusHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "vector" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceBotKnowledgeEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceBotPriceVersion" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "inputCreditsPer1M" DECIMAL(24,8) NOT NULL,
    "cachedInputCreditsPer1M" DECIMAL(24,8) NOT NULL,
    "outputCreditsPer1M" DECIMAL(24,8) NOT NULL,
    "embeddingCreditsPer1M" DECIMAL(24,8) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceBotPriceVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceBotUsageReservation" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" TEXT NOT NULL,
    "reservedCredits" DECIMAL(24,8) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceBotUsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceBotUsageRecord" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "inputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL,
    "embeddingInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "theoreticalCostCredits" DECIMAL(24,8) NOT NULL,
    "chargedCredits" DECIMAL(24,8) NOT NULL,
    "status" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceBotUsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResourceBotEmbedding_corpus_model_chunk_key" ON "ResourceBotKnowledgeEmbedding"("corpusHash", "embeddingModel", "chunkId");
CREATE INDEX "ResourceBotEmbedding_corpus_model_idx" ON "ResourceBotKnowledgeEmbedding"("corpusHash", "embeddingModel");
CREATE UNIQUE INDEX "ResourceBotPrice_provider_model_effective_key" ON "ResourceBotPriceVersion"("provider", "model", "effectiveFrom");
CREATE INDEX "ResourceBotPrice_provider_model_effective_idx" ON "ResourceBotPriceVersion"("provider", "model", "effectiveFrom" DESC);
CREATE UNIQUE INDEX "ResourceBotUsageReservation_requestId_key" ON "ResourceBotUsageReservation"("requestId");
CREATE INDEX "ResourceBotReservation_account_expiry_idx" ON "ResourceBotUsageReservation"("billingAccountId", "expiresAt");
CREATE INDEX "ResourceBotReservation_tenant_created_idx" ON "ResourceBotUsageReservation"("tenantId", "createdAt");
CREATE UNIQUE INDEX "ResourceBotUsageRecord_requestId_key" ON "ResourceBotUsageRecord"("requestId");
CREATE INDEX "ResourceBotUsage_tenant_created_idx" ON "ResourceBotUsageRecord"("tenantId", "createdAt" DESC);
CREATE INDEX "ResourceBotUsage_account_created_idx" ON "ResourceBotUsageRecord"("billingAccountId", "createdAt" DESC);

ALTER TABLE "TenantResourceBotSettings" ADD CONSTRAINT "TenantResourceBotSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBotUsageReservation" ADD CONSTRAINT "ResourceBotUsageReservation_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBotUsageReservation" ADD CONSTRAINT "ResourceBotUsageReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBotUsageRecord" ADD CONSTRAINT "ResourceBotUsageRecord_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBotUsageRecord" ADD CONSTRAINT "ResourceBotUsageRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBotUsageRecord" ADD CONSTRAINT "ResourceBotUsageRecord_priceVersionId_fkey" FOREIGN KEY ("priceVersionId") REFERENCES "ResourceBotPriceVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "Permission" ("id") VALUES ('resourcebot.use'), ('resourcebot.settings.manage') ON CONFLICT ("id") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."id" IN ('resourcebot.use', 'resourcebot.settings.manage')
WHERE r."id" = 'tenant-admin'
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."id" = 'resourcebot.use'
WHERE r."id" IN ('resource-admin', 'billing-admin', 'viewer')
ON CONFLICT DO NOTHING;

UPDATE "Role"
SET "permissions" = array_append("permissions", 'resourcebot.use')
WHERE "id" = 'tenant-admin'
  AND NOT ('resourcebot.use' = ANY("permissions"));

UPDATE "Role"
SET "permissions" = array_append("permissions", 'resourcebot.settings.manage')
WHERE "id" = 'tenant-admin'
  AND NOT ('resourcebot.settings.manage' = ANY("permissions"));

UPDATE "Role"
SET "permissions" = array_append("permissions", 'resourcebot.use')
WHERE "id" IN ('resource-admin','billing-admin','viewer')
  AND NOT ('resourcebot.use' = ANY("permissions"));
