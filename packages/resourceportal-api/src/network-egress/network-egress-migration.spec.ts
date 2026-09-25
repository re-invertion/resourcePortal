import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const baseMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260920170000_v022_network_egress_policy/migration.sql",
  ),
  "utf8",
);

const cleanupMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260925165500_remove_legacy_privileged_networking/migration.sql",
  ),
  "utf8",
);

describe("network egress migrations", () => {
  it("keeps the global private-network protection policy enabled by default", () => {
    expect(baseMigration).toContain('CREATE TABLE "PlatformEgressPolicy"');
    expect(baseMigration).toContain(
      "'00000000-0000-4000-8000-000000000022', true, 1",
    );
  });

  it("refuses destructive cleanup while deprecated networking state still exists", () => {
    expect(cleanupMigration).toContain(
      'IF EXISTS (SELECT 1 FROM "AppGroup" WHERE "networkPrivileged" = true)',
    );
    expect(cleanupMigration).toContain(
      'IF EXISTS (SELECT 1 FROM "InternalPortExposure" LIMIT 1)',
    );
    expect(cleanupMigration).toContain(
      'IF EXISTS (SELECT 1 FROM "PlatformEgressAllowRule" LIMIT 1)',
    );
  });

  it("removes the deprecated schema after the safety checks", () => {
    expect(cleanupMigration).toContain('DROP TABLE "InternalPortExposure"');
    expect(cleanupMigration).toContain('DROP TABLE "PlatformEgressAllowRule"');
    expect(cleanupMigration).toContain(
      'ALTER TABLE "AppGroup" DROP COLUMN "networkPrivileged"',
    );
  });
});
