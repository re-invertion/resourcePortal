import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Site VPN direction firewall migration", () => {
  it("preserves LAN to RP access but defaults RP to LAN to deny", () => {
    const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    const migration = readFileSync(resolve(__dirname, "../../prisma/migrations/20261010161500_site_vpn_firewall_policy/migration.sql"), "utf8");
    expect(schema).toMatch(/allowLanToRp\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/allowRpToLan\s+Boolean\s+@default\(false\)/);
    expect(migration).toContain('ADD COLUMN "allowLanToRp" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('ADD COLUMN "allowRpToLan" BOOLEAN NOT NULL DEFAULT false');
  });
});
