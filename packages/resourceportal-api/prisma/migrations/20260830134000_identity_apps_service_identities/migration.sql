-- Platform Identity Providers must have globally unique names even though tenantId is NULL.
CREATE UNIQUE INDEX "IdentityProvider_platform_name_key"
ON "IdentityProvider"("name")
WHERE "scope" = 'Platform' AND "tenantId" IS NULL;

CREATE TABLE "OAuthApplication" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "redirectUris" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "postLogoutRedirectUris" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "zitadelApplicationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretCiphertext" TEXT,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OAuthApplication_type_check" CHECK ("type" IN ('Web', 'SPA', 'Native', 'Machine')),
    CONSTRAINT "OAuthApplication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OAuthApplication_tenantId_name_key" ON "OAuthApplication"("tenantId", "name");
CREATE UNIQUE INDEX "OAuthApplication_zitadelApplicationId_key" ON "OAuthApplication"("zitadelApplicationId");
CREATE UNIQUE INDEX "OAuthApplication_clientId_key" ON "OAuthApplication"("clientId");
CREATE INDEX "OAuthApplication_tenantId_type_idx" ON "OAuthApplication"("tenantId", "type");

CREATE TABLE "ServiceIdentity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "zitadelUserId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretCiphertext" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceIdentity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServiceIdentity_status_check" CHECK ("status" IN ('Active', 'Suspended')),
    CONSTRAINT "ServiceIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ServiceIdentity_tenantId_name_key" ON "ServiceIdentity"("tenantId", "name");
CREATE UNIQUE INDEX "ServiceIdentity_zitadelUserId_key" ON "ServiceIdentity"("zitadelUserId");
CREATE UNIQUE INDEX "ServiceIdentity_clientId_key" ON "ServiceIdentity"("clientId");
CREATE INDEX "ServiceIdentity_tenantId_status_idx" ON "ServiceIdentity"("tenantId", "status");

CREATE TABLE "ServiceIdentityRole" (
    "serviceIdentityId" UUID NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "ServiceIdentityRole_pkey" PRIMARY KEY ("serviceIdentityId", "roleId"),
    CONSTRAINT "ServiceIdentityRole_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "ServiceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceIdentityRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ServiceIdentityRole_roleId_idx" ON "ServiceIdentityRole"("roleId");
