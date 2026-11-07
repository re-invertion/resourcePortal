-- CreateTable
CREATE TABLE "TenantAppConsumer" (
    "membershipId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAppConsumer_pkey" PRIMARY KEY ("membershipId")
);

-- CreateTable
CREATE TABLE "TenantAppClientGrant" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "oauthApplicationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAppClientGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantAppInvitationGrant" (
    "invitationId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "oauthApplicationId" UUID NOT NULL,

    CONSTRAINT "TenantAppInvitationGrant_pkey" PRIMARY KEY ("invitationId","oauthApplicationId")
);

-- CreateIndex
CREATE INDEX "TenantAppConsumer_tenantId_idx" ON "TenantAppConsumer"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAppConsumer_membershipId_tenantId_key" ON "TenantAppConsumer"("membershipId", "tenantId");

-- CreateIndex
CREATE INDEX "TenantAppClientGrant_tenantId_oauthApplicationId_enabled_idx" ON "TenantAppClientGrant"("tenantId", "oauthApplicationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAppClientGrant_membershipId_oauthApplicationId_key" ON "TenantAppClientGrant"("membershipId", "oauthApplicationId");

-- CreateIndex
CREATE INDEX "TenantAppInvitationGrant_tenantId_oauthApplicationId_idx" ON "TenantAppInvitationGrant"("tenantId", "oauthApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMembership_id_tenantId_key" ON "TenantMembership"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthApplication_id_tenantId_key" ON "OAuthApplication"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantInvitation_id_tenantId_key" ON "TenantInvitation"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "TenantAppConsumer" ADD CONSTRAINT "TenantAppConsumer_membershipId_tenantId_fkey" FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantMembership"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAppConsumer" ADD CONSTRAINT "TenantAppConsumer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAppClientGrant" ADD CONSTRAINT "TenantAppClientGrant_membershipId_tenantId_fkey" FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantAppConsumer"("membershipId", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAppClientGrant" ADD CONSTRAINT "TenantAppClientGrant_oauthApplicationId_tenantId_fkey" FOREIGN KEY ("oauthApplicationId", "tenantId") REFERENCES "OAuthApplication"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAppInvitationGrant" ADD CONSTRAINT "TenantAppInvitationGrant_invitationId_tenantId_fkey" FOREIGN KEY ("invitationId", "tenantId") REFERENCES "TenantInvitation"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAppInvitationGrant" ADD CONSTRAINT "TenantAppInvitationGrant_oauthApplicationId_tenantId_fkey" FOREIGN KEY ("oauthApplicationId", "tenantId") REFERENCES "OAuthApplication"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

