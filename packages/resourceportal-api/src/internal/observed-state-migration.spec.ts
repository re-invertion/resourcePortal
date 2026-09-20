import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 observed state migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260919211500_v020_observed_runtime_state/migration.sql",
    ),
    "utf8",
  );

  it("is additive and nullable for supported v0.1.x upgrades", () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "lastObservedAt" TIMESTAMP(3)');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "observedDesiredReplicas" INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "observedImage" TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "observedAt" TIMESTAMP(3)');
    expect(migration).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(migration).not.toContain("NOT NULL");
  });
});
