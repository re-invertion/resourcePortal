import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 Operation migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260919194500_v020_runtime_architecture/migration.sql",
    ),
    "utf8",
  );

  it("adds a global idempotency invariant for tenantId NULL Operations", () => {
    expect(migration).toContain("Operation_global_type_idempotencyKey_key");
    expect(migration).toContain('WHERE "tenantId" IS NULL AND "idempotencyKey" IS NOT NULL');
  });

  it("deduplicates historical global keys before creating the unique index", () => {
    expect(migration).toContain("ranked_global_operations");
    expect(migration).toContain('SET "idempotencyKey" = NULL');
    expect(migration.indexOf("ranked_global_operations")).toBeLessThan(
      migration.indexOf("Operation_global_type_idempotencyKey_key"),
    );
  });
});
