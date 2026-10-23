import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Retirement of routed Gate firewall policy", () => {
  it("drops the obsolete routed direction grants in the milestone migration", () => {
    const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    const sql = readFileSync(resolve(__dirname,
      "../../prisma/migrations/20261023110500_retire_site_vpn/migration.sql"), "utf8");
    expect(schema).not.toMatch(/allowLanToRp\\s+Boolean|allowRpToLan\\s+Boolean/);
    expect(sql).toContain('DROP COLUMN "allowLanToRp"');
    expect(sql).toContain('DROP COLUMN "allowRpToLan"');
    expect(sql).toContain('DROP TABLE "GateNetworkAttachment"');
    // The historical migration remains immutable so existing installations
    // can be replayed up to this point and restored during failed upgrades.
    const historic=readFileSync(resolve(__dirname,
      "../../prisma/migrations/20261010161500_site_vpn_firewall_policy/migration.sql"), "utf8");
    expect(historic).toContain('ADD COLUMN "allowRpToLan"');
  });
});
