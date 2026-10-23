-- Remote LAN attachments are explicit, tenant-scoped desired state.
-- No Site VPN information is migrated into active L2 membership.
CREATE TABLE "RemoteLanAttachment" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "singleAppId" UUID NOT NULL,
  "networkId" UUID NOT NULL,
  "gateId" UUID NOT NULL,
  "lanInterface" VARCHAR(15) NOT NULL,
  "lanCidr" VARCHAR(18) NOT NULL,
  "macAddress" VARCHAR(17) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "dhcpAddress" VARCHAR(15),
  "leaseExpiresAt" TIMESTAMP(3),
  "lastVerifiedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RemoteLanAttachment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RemoteLanAttachment_singleAppId_key" ON "RemoteLanAttachment"("singleAppId");
CREATE UNIQUE INDEX "RemoteLanAttachment_macAddress_key" ON "RemoteLanAttachment"("macAddress");
CREATE INDEX "RemoteLanAttachment_tenantId_status_idx" ON "RemoteLanAttachment"("tenantId", "status");
CREATE INDEX "RemoteLanAttachment_gateId_status_idx" ON "RemoteLanAttachment"("gateId", "status");
CREATE INDEX "RemoteLanAttachment_networkId_idx" ON "RemoteLanAttachment"("networkId");
ALTER TABLE "RemoteLanAttachment"
  ADD CONSTRAINT "RemoteLanAttachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteLanAttachment"
  ADD CONSTRAINT "RemoteLanAttachment_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteLanAttachment"
  ADD CONSTRAINT "RemoteLanAttachment_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteLanAttachment"
  ADD CONSTRAINT "RemoteLanAttachment_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "ResourcePortalGate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
