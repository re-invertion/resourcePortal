CREATE TABLE "DeviceVpnGateway" (
  "id" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKeyCiphertext" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "runtimeTokenHash" TEXT NOT NULL,
  "runtimeTokenCiphertext" TEXT NOT NULL,
  "listenPort" INTEGER NOT NULL,
  "serverTunnelAddress" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Provisioning',
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceVpnGateway_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceVpnDevice" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "assignedAddress" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "configRevision" INTEGER NOT NULL DEFAULT 1,
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceVpnDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceVpnNetworkAccess" (
  "id" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "networkId" UUID NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceVpnNetworkAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceVpnGateway_publicKey_key" ON "DeviceVpnGateway"("publicKey");
CREATE UNIQUE INDEX "DeviceVpnGateway_runtimeTokenHash_key" ON "DeviceVpnGateway"("runtimeTokenHash");
CREATE UNIQUE INDEX "DeviceVpnGateway_listenPort_key" ON "DeviceVpnGateway"("listenPort");
CREATE UNIQUE INDEX "DeviceVpnDevice_publicKey_key" ON "DeviceVpnDevice"("publicKey");
CREATE UNIQUE INDEX "DeviceVpnDevice_assignedAddress_key" ON "DeviceVpnDevice"("assignedAddress");
CREATE UNIQUE INDEX "DeviceVpnDevice_tenantId_userId_name_key" ON "DeviceVpnDevice"("tenantId","userId","name");
CREATE INDEX "DeviceVpnDevice_tenantId_userId_status_idx" ON "DeviceVpnDevice"("tenantId","userId","status");
CREATE INDEX "DeviceVpnDevice_status_revokedAt_idx" ON "DeviceVpnDevice"("status","revokedAt");
CREATE UNIQUE INDEX "DeviceVpnNetworkAccess_deviceId_networkId_key" ON "DeviceVpnNetworkAccess"("deviceId","networkId");
CREATE INDEX "DeviceVpnNetworkAccess_networkId_idx" ON "DeviceVpnNetworkAccess"("networkId");

ALTER TABLE "DeviceVpnDevice"
  ADD CONSTRAINT "DeviceVpnDevice_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceVpnDevice"
  ADD CONSTRAINT "DeviceVpnDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceVpnNetworkAccess"
  ADD CONSTRAINT "DeviceVpnNetworkAccess_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "DeviceVpnDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceVpnNetworkAccess"
  ADD CONSTRAINT "DeviceVpnNetworkAccess_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permission" ("id")
VALUES ('device_vpn.read'), ('device_vpn.create'), ('device_vpn.manage'), ('device_vpn.delete')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT roles.role_id, permissions.permission_id
FROM (VALUES ('tenant-admin'), ('resource-admin')) AS roles(role_id)
CROSS JOIN (VALUES
  ('device_vpn.read'), ('device_vpn.create'), ('device_vpn.manage'), ('device_vpn.delete')
) AS permissions(permission_id)
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = roles.role_id)
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT 'viewer', 'device_vpn.read'
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = 'viewer')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

UPDATE "Role"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT value
    FROM unnest("permissions" || ARRAY[
      'device_vpn.read','device_vpn.create','device_vpn.manage','device_vpn.delete'
    ]::TEXT[]) AS value
    ORDER BY value
  )
)
WHERE "id" IN ('tenant-admin', 'resource-admin');

UPDATE "Role"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT value
    FROM unnest("permissions" || ARRAY['device_vpn.read']::TEXT[]) AS value
    ORDER BY value
  )
)
WHERE "id" = 'viewer';
