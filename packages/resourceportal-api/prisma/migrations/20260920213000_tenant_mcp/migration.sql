CREATE TABLE "TenantMcpSettings" (
    "tenantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "accessMode" TEXT NOT NULL DEFAULT 'SelectedMembers',
    "updatedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantMcpSettings_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "TenantMcpMemberAccess" (
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantMcpMemberAccess_pkey" PRIMARY KEY ("tenantId", "membershipId")
);

CREATE INDEX "TenantMcpMemberAccess_membershipId_idx" ON "TenantMcpMemberAccess"("membershipId");

ALTER TABLE "TenantMcpSettings" ADD CONSTRAINT "TenantMcpSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMcpMemberAccess" ADD CONSTRAINT "TenantMcpMemberAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantMcpSettings"("tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMcpMemberAccess" ADD CONSTRAINT "TenantMcpMemberAccess_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "TenantMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
