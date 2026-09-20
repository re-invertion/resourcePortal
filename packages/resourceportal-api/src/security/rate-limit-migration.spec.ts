import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 shared rate-limit migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260919214500_v020_shared_rate_limit/migration.sql",
    ),
    "utf8",
  );

  it("is additive and creates the shared bucket table/index", () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "ApiRateLimitBucket"');
    expect(migration).toContain('CONSTRAINT "ApiRateLimitBucket_pkey" PRIMARY KEY ("key")');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "ApiRateLimitBucket_resetAt_idx"');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
