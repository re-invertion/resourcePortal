CREATE TABLE "TenantAuthPolicy" (
    "tenantId" UUID NOT NULL,
    "allowPlatformLogin" BOOLEAN NOT NULL DEFAULT true,
    "allowTenantIdentityProviders" BOOLEAN NOT NULL DEFAULT true,
    "requireTenantIdentityProvider" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAuthPolicy_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "TenantInvitation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "roleIds" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantGroupMember" (
    "id" UUID NOT NULL,
    "tenantGroupId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'Manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantGroupRole" (
    "tenantGroupId" UUID NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "TenantGroupRole_pkey" PRIMARY KEY ("tenantGroupId","roleId")
);

CREATE UNIQUE INDEX "TenantInvitation_tokenHash_key" ON "TenantInvitation"("tokenHash");
CREATE UNIQUE INDEX "TenantInvitation_tenantId_email_key" ON "TenantInvitation"("tenantId", "email");
CREATE UNIQUE INDEX "TenantGroup_tenantId_name_key" ON "TenantGroup"("tenantId", "name");
CREATE UNIQUE INDEX "TenantGroupMember_tenantGroupId_membershipId_key" ON "TenantGroupMember"("tenantGroupId", "membershipId");

ALTER TABLE "TenantAuthPolicy" ADD CONSTRAINT "TenantAuthPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantInvitation" ADD CONSTRAINT "TenantInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantGroup" ADD CONSTRAINT "TenantGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantGroupMember" ADD CONSTRAINT "TenantGroupMember_tenantGroupId_fkey" FOREIGN KEY ("tenantGroupId") REFERENCES "TenantGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantGroupMember" ADD CONSTRAINT "TenantGroupMember_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "TenantMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantGroupRole" ADD CONSTRAINT "TenantGroupRole_tenantGroupId_fkey" FOREIGN KEY ("tenantGroupId") REFERENCES "TenantGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantGroupRole" ADD CONSTRAINT "TenantGroupRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "TenantAuthPolicy" ("tenantId", "updatedAt")
SELECT "id", CURRENT_TIMESTAMP FROM "Tenant"
ON CONFLICT ("tenantId") DO NOTHING;
