import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260920184500_v022_privileged_networking/migration.sql",
  ),
  "utf8",
);

describe("v0.2.2 privileged networking migration", () => {
  it("adds privilege and internal port exposure storage without destructive data changes", () => {
    expect(migration).toContain(
      'ADD COLUMN "networkPrivileged" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(migration).toContain('CREATE TABLE "InternalPortExposure"');
    expect(migration).toContain(
      'FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id")',
    );
    expect(migration).toContain(
      '"InternalPortExposure_protocol_publishedPort_key"',
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
