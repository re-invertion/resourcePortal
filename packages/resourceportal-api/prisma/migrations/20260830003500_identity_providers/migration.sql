CREATE TYPE "IdentityProviderScope" AS ENUM ('Platform', 'Tenant');
CREATE TYPE "IdentityProviderProtocol" AS ENUM ('OIDC', 'SAML');

CREATE TABLE "IdentityProvider" (
  "id" UUID NOT NULL,
  "scope" "IdentityProviderScope" NOT NULL,
  "tenantId" UUID,
  "name" TEXT NOT NULL,
  "protocol" "IdentityProviderProtocol" NOT NULL,
  "zitadelIdentityProviderId" TEXT,
  "issuer" TEXT,
  "metadataUrl" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" UUID NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdentityProvider_zitadelIdentityProviderId_key" ON "IdentityProvider"("zitadelIdentityProviderId");
CREATE UNIQUE INDEX "IdentityProvider_tenantId_name_key" ON "IdentityProvider"("tenantId", "name");
CREATE INDEX "IdentityProvider_scope_enabled_idx" ON "IdentityProvider"("scope", "enabled");
CREATE INDEX "IdentityProvider_tenantId_enabled_idx" ON "IdentityProvider"("tenantId", "enabled");

ALTER TABLE "IdentityProvider"
ADD CONSTRAINT "IdentityProvider_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserIdentity"
ADD CONSTRAINT "UserIdentity_identityProviderId_fkey"
FOREIGN KEY ("identityProviderId") REFERENCES "IdentityProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IdentityProvider"
ADD CONSTRAINT "IdentityProvider_scope_tenant_check"
CHECK (("scope" = 'Platform' AND "tenantId" IS NULL) OR ("scope" = 'Tenant' AND "tenantId" IS NOT NULL));
