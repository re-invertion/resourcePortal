import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();
const schema = readFileSync(resolve(packageRoot, "prisma/schema.prisma"), "utf8");
const migrationRoot = resolve(packageRoot, "prisma/migrations");

function modelNames() {
  return new Set(
    [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]),
  );
}

function migrationSql() {
  return readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(migrationRoot, entry.name, "migration.sql"))
    .filter((path) => {
      try {
        readFileSync(path, "utf8");
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("Prisma schema source of truth", () => {
  it("models every table created by migration history", () => {
    const models = modelNames();
    const sql = migrationSql();
    const tables = new Set(
      [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"([^"]+)"/gi)].map(
        (match) => match[1],
      ),
    );
    for (const match of sql.matchAll(/DROP TABLE(?: IF EXISTS)?\s+"([^"]+)"/gi)) {
      tables.delete(match[1]);
    }
    expect([...tables].filter((table) => !models.has(table)).sort()).toEqual([]);
    expect(models.size).toBe(tables.size);
  });

  it("models every application table referenced from raw SQL", () => {
    const models = modelNames();
    const tables = new Set<string>();
    for (const path of sourceFiles(resolve(packageRoot, "src"))) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("$queryRaw") && !source.includes("$executeRaw")) continue;
      for (const match of source.matchAll(/(?:FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+"([A-Za-z][A-Za-z0-9_]*)"/g)) {
        tables.add(match[1]);
      }
    }
    expect([...tables].filter((table) => !models.has(table)).sort()).toEqual([]);
  });

  it("describes the production billing precision and post-stage10 columns", () => {
    expect(schema).toMatch(/balance\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(24, 8\)/);
    expect(schema).toMatch(/informationThreshold\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(24, 8\)/);
    expect(schema).toMatch(/amount\s+Decimal\s+@db\.Decimal\(24, 8\)/);
    expect(schema).toMatch(/reason\s+String\?/);
    expect(schema).toMatch(/sourceTransactionId\s+String\?\s+@db\.Uuid/);
    expect(schema).toMatch(/metadata\s+Json\?/);
    expect(schema).toMatch(/chargedCredits\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(24, 8\)/);
    expect(schema).toMatch(/priceListVersionId\s+String\?\s+@db\.Uuid/);
    expect(schema).toMatch(/appGroupId\s+String\?\s+@db\.Uuid/);
  });

  it("keeps ordinary CRUD modules on Prisma instead of raw table SQL", () => {
    const cleaned = [
      "src/oauth-applications/oauth-applications.service.ts",
      "src/oauth-applications/platform-oauth-applications.service.ts",
      "src/oauth-applications/oauth-application-credentials.service.ts",
      "src/service-identities/service-identities.service.ts",
      "src/service-identities/platform-service-identities.service.ts",
      "src/service-identities/service-identity-credentials.service.ts",
      "src/platform-maintenance/platform-maintenance.store.ts",
      "src/platform-infrastructure/swarm-infrastructure.store.ts",
    ];
    for (const relative of cleaned) {
      const source = readFileSync(resolve(packageRoot, relative), "utf8");
      expect(source, relative).not.toContain("$queryRaw");
      expect(source, relative).not.toContain("$executeRaw");
    }
  });
});
