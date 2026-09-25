-- Advanced tenant networking and ResourcePortalGate foundation.
-- Additive phase: legacy privileged networking remains intact until the dedicated migration phase.

CREATE TABLE "Network" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "cidr" TEXT NOT NULL,
  "overlayCidr" TEXT NOT NULL,
  "swarmNetworkName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Provisioning',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastObservedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Network_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NetworkAttachment" (
  "id" UUID NOT NULL,
  "networkId" UUID NOT NULL,
  "singleAppId" UUID NOT NULL,
  "address" TEXT NOT NULL,
  "observedServiceVip" TEXT,
  "lastObservedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NetworkAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourcePortalGate" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PendingEnrollment',
  "publicKey" TEXT,
  "serverPublicKey" TEXT,
  "serverPrivateKeyCiphertext" TEXT,
  "serverKeyVersion" INTEGER NOT NULL DEFAULT 1,
  "serverListenPort" INTEGER,
  "clientTunnelAddress" TEXT,
  "serverTunnelAddress" TEXT,
  "agentTokenHash" TEXT,
  "configRevision" INTEGER NOT NULL DEFAULT 1,
  "lanAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lanCidrs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "agentVersion" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResourcePortalGate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GateNetworkAttachment" (
  "id" UUID NOT NULL,
  "gateId" UUID NOT NULL,
  "networkId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastObservedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GateNetworkAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourcePortalGateEnrollment" (
  "id" UUID NOT NULL,
  "gateId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourcePortalGateEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Network_tenantId_name_key" ON "Network"("tenantId", "name");
CREATE UNIQUE INDEX "Network_cidr_key" ON "Network"("cidr");
CREATE UNIQUE INDEX "Network_overlayCidr_key" ON "Network"("overlayCidr");
CREATE UNIQUE INDEX "Network_swarmNetworkName_key" ON "Network"("swarmNetworkName");
CREATE INDEX "Network_tenantId_status_idx" ON "Network"("tenantId", "status");

CREATE UNIQUE INDEX "NetworkAttachment_networkId_singleAppId_key" ON "NetworkAttachment"("networkId", "singleAppId");
CREATE UNIQUE INDEX "NetworkAttachment_networkId_address_key" ON "NetworkAttachment"("networkId", "address");
CREATE INDEX "NetworkAttachment_singleAppId_idx" ON "NetworkAttachment"("singleAppId");

CREATE UNIQUE INDEX "ResourcePortalGate_tenantId_name_key" ON "ResourcePortalGate"("tenantId", "name");
CREATE UNIQUE INDEX "ResourcePortalGate_publicKey_key" ON "ResourcePortalGate"("publicKey");
CREATE UNIQUE INDEX "ResourcePortalGate_serverPublicKey_key" ON "ResourcePortalGate"("serverPublicKey");
CREATE UNIQUE INDEX "ResourcePortalGate_serverListenPort_key" ON "ResourcePortalGate"("serverListenPort");
CREATE UNIQUE INDEX "ResourcePortalGate_clientTunnelAddress_key" ON "ResourcePortalGate"("clientTunnelAddress");
CREATE UNIQUE INDEX "ResourcePortalGate_serverTunnelAddress_key" ON "ResourcePortalGate"("serverTunnelAddress");
CREATE UNIQUE INDEX "ResourcePortalGate_agentTokenHash_key" ON "ResourcePortalGate"("agentTokenHash");
CREATE INDEX "ResourcePortalGate_tenantId_status_idx" ON "ResourcePortalGate"("tenantId", "status");

CREATE UNIQUE INDEX "GateNetworkAttachment_gateId_networkId_key" ON "GateNetworkAttachment"("gateId", "networkId");
CREATE INDEX "GateNetworkAttachment_networkId_idx" ON "GateNetworkAttachment"("networkId");

CREATE UNIQUE INDEX "ResourcePortalGateEnrollment_tokenHash_key" ON "ResourcePortalGateEnrollment"("tokenHash");
CREATE INDEX "ResourcePortalGateEnrollment_gateId_expiresAt_idx" ON "ResourcePortalGateEnrollment"("gateId", "expiresAt");

ALTER TABLE "Network"
  ADD CONSTRAINT "Network_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NetworkAttachment"
  ADD CONSTRAINT "NetworkAttachment_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NetworkAttachment"
  ADD CONSTRAINT "NetworkAttachment_singleAppId_fkey"
  FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResourcePortalGate"
  ADD CONSTRAINT "ResourcePortalGate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GateNetworkAttachment"
  ADD CONSTRAINT "GateNetworkAttachment_gateId_fkey"
  FOREIGN KEY ("gateId") REFERENCES "ResourcePortalGate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GateNetworkAttachment"
  ADD CONSTRAINT "GateNetworkAttachment_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResourcePortalGateEnrollment"
  ADD CONSTRAINT "ResourcePortalGateEnrollment_gateId_fkey"
  FOREIGN KEY ("gateId") REFERENCES "ResourcePortalGate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permission" ("id")
VALUES
  ('network.read'),
  ('network.create'),
  ('network.update'),
  ('network.delete'),
  ('network.attach'),
  ('gate.read'),
  ('gate.create'),
  ('gate.update'),
  ('gate.delete'),
  ('gate.manage')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT roles.role_id, permissions.permission_id
FROM (
  VALUES ('tenant-admin'), ('resource-admin')
) AS roles(role_id)
CROSS JOIN (
  VALUES
    ('network.read'),
    ('network.create'),
    ('network.update'),
    ('network.delete'),
    ('network.attach'),
    ('gate.read'),
    ('gate.create'),
    ('gate.update'),
    ('gate.delete'),
    ('gate.manage')
) AS permissions(permission_id)
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = roles.role_id)
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT 'viewer', permissions.permission_id
FROM (VALUES ('network.read'), ('gate.read')) AS permissions(permission_id)
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = 'viewer')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

UPDATE "Role"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT value
    FROM unnest(
      "permissions" || ARRAY[
        'network.read','network.create','network.update','network.delete','network.attach',
        'gate.read','gate.create','gate.update','gate.delete','gate.manage'
      ]::TEXT[]
    ) AS value
    ORDER BY value
  )
)
WHERE "id" IN ('tenant-admin', 'resource-admin');

UPDATE "Role"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT value
    FROM unnest("permissions" || ARRAY['network.read','gate.read']::TEXT[]) AS value
    ORDER BY value
  )
)
WHERE "id" = 'viewer';
