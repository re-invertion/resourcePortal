-- Expand-only migration: legacy inbound IdentityProvider, TenantAuthPolicy and OAuthApplication remain intact.
-- Tenant OIDC begins disabled, pending verified role assignments and live ZITADEL integration.
CREATE TABLE "TenantOidcProvider" (
    "tenantId" UUID NOT NULL,
    "zitadelProjectId" TEXT,
    "issuer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "grantsReconciledAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantOidcProvider_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "TenantOidcGrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "zitadelUserId" TEXT NOT NULL,
    "zitadelGrantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantOidcGrant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OAuthApplication" ADD COLUMN "zitadelProjectId" TEXT;
CREATE UNIQUE INDEX "TenantOidcProvider_zitadelProjectId_key" ON "TenantOidcProvider"("zitadelProjectId");
CREATE UNIQUE INDEX "TenantOidcGrant_zitadelGrantId_key" ON "TenantOidcGrant"("zitadelGrantId");
CREATE UNIQUE INDEX "TenantOidcGrant_tenantId_userId_key" ON "TenantOidcGrant"("tenantId", "userId");
CREATE INDEX "TenantOidcGrant_tenantId_status_idx" ON "TenantOidcGrant"("tenantId", "status");
ALTER TABLE "TenantOidcProvider" ADD CONSTRAINT "TenantOidcProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantOidcGrant" ADD CONSTRAINT "TenantOidcGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOidcProvider"("tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantOidcGrant" ADD CONSTRAINT "TenantOidcGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
