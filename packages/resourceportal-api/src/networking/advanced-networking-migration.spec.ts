import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260925112000_advanced_networking_gate/migration.sql",
  ),
  "utf8",
);

const bgpMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260929191500_gate_bgp_advertisement/migration.sql",
  ),
  "utf8",
);

describe("advanced networking + ResourcePortalGate migration", () => {
  it("adds first-class tenant networks and Gate resources without removing legacy networking", () => {
    expect(migration).toContain('CREATE TABLE "Network"');
    expect(migration).toContain('CREATE TABLE "NetworkAttachment"');
    expect(migration).toContain('CREATE TABLE "ResourcePortalGate"');
    expect(migration).toContain('CREATE TABLE "GateNetworkAttachment"');
    expect(migration).toContain('CREATE TABLE "ResourcePortalGateEnrollment"');
    expect(migration).toContain('"Network_cidr_key"');
    expect(migration).toContain('"Network_overlayCidr_key"');
    expect(migration).toContain('"NetworkAttachment_networkId_address_key"');
    expect(migration).toContain("'network.attach'");
    expect(migration).toContain("'gate.manage'");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
    expect(migration).not.toMatch(/ALTER TABLE "AppGroup" .*DROP/i);
    expect(migration).not.toMatch(/ALTER TABLE "SingleApp" .*DROP/i);
  });

  it("keeps routed IP networking and does not introduce DNS resources", () => {
    expect(migration).not.toMatch(/CREATE TABLE "[^"]*Dns/i);
    expect(migration).not.toMatch(/dnsName|hostname|serviceDiscovery/i);
  });

  it("adds BGP as an opt-in, backward-compatible Gate routing mode", () => {
    expect(bgpMigration).toContain(
      '"routeAdvertisementMode" TEXT NOT NULL DEFAULT \'Manual\'',
    );
    expect(bgpMigration).toContain('"bgpLocalAsn" BIGINT');
    expect(bgpMigration).toContain('"bgpRouterAddress" TEXT');
    expect(bgpMigration).toContain('"bgpRouterAsn" BIGINT');
    expect(bgpMigration).toContain('"bgpSourceAddress" TEXT');
    expect(bgpMigration).toContain(
      '"bgpHoldTimeSeconds" INTEGER NOT NULL DEFAULT 90',
    );
    expect(bgpMigration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
  });
});
