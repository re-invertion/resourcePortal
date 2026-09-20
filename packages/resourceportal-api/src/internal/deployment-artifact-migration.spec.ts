import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 exact deployment artifact migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260919221500_v020_exact_deployment_artifact/migration.sql",
    ),
    "utf8",
  );

  it("adds only a nullable digest column for online v0.1.x compatibility", () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "renderedStackSha256" VARCHAR(64)',
    );
    expect(migration).not.toContain("NOT NULL");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
