import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 worker observability migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260919224000_v020_worker_observability/migration.sql",
    ),
    "utf8",
  );

  it("adds durable worker/reconciliation state without destructive schema changes", () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "WorkerRuntimeState"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "WorkerReconciliationState"',
    );
    expect(migration).toContain('FOREIGN KEY ("workerId")');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
