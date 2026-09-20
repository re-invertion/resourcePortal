import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260920170000_v022_network_egress_policy/migration.sql",
  ),
  "utf8",
);

describe("v0.2.2 network egress migration", () => {
  it("is additive and enables private-network protection by default", () => {
    expect(migration).toContain('CREATE TABLE "PlatformEgressPolicy"');
    expect(migration).toContain('CREATE TABLE "PlatformEgressAllowRule"');
    expect(migration).toContain(
      "'00000000-0000-4000-8000-000000000022', true, 1",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id")',
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/ALTER TABLE "AppGroup" .*DROP/i);
  });
});
