import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Device VPN migration", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20261007110000_device_vpn/migration.sql",
    ),
    "utf8",
  );

  it("creates separate Device VPN gateway, device and Network access models", () => {
    expect(migration).toContain('CREATE TABLE "DeviceVpnGateway"');
    expect(migration).toContain('CREATE TABLE "DeviceVpnDevice"');
    expect(migration).toContain('CREATE TABLE "DeviceVpnNetworkAccess"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "DeviceVpnDevice_assignedAddress_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "DeviceVpnNetworkAccess_deviceId_networkId_key"',
    );
  });

  it("adds dedicated RBAC permissions instead of reusing Site VPN gate permissions", () => {
    expect(migration).toContain("'device_vpn.read'");
    expect(migration).toContain("'device_vpn.create'");
    expect(migration).toContain("'device_vpn.manage'");
    expect(migration).toContain("'device_vpn.delete'");
  });
});
