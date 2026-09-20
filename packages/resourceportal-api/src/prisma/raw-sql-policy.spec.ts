import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(process.cwd(), "src");

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

const allowedRawSqlFiles = new Set([
  // Atomic usage dedupe plus BillingAccount row locking.
  "billing/billing-usage.service.ts",
  // Price-list advisory lock, Voucher/BillingAccount FOR UPDATE.
  "billing/billing.service.ts",
  // Platform capacity snapshot + advisory mutation lock.
  "capacity/capacity-preflight.service.ts",
  // Minimal SELECT 1 readiness probe.
  "health/health.controller.ts",
  // Atomic mirrored Operation + OperationEvent creation in caller transaction.
  "operations/deployment-operation-adapter.service.ts",
  // SKIP LOCKED claim/lease CAS and idempotent Operation state transitions.
  "operations/operations.repository.ts",
  // Cross-replica atomic fixed-window upsert.
  "security/rate-limit.service.ts",
  // PostgreSQL sequence, advisory capacity lock, COALESCE reservation aggregate,
  // and compare-and-set resize reservation.
  "storage-backends/storage-backend.store.ts",
  // Tenant quota advisory transaction lock.
  "tenants/quota-concurrency.ts",
  // Reservation calculation using pending-or-current volume size in one query.
  "volumes/volumes.service.ts",
]);

describe("raw SQL policy", () => {
  it("limits raw SQL to reviewed concurrency/aggregate/probe code paths", () => {
    const actual = sourceFiles(srcRoot)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return source.includes("$queryRaw") || source.includes("$executeRaw");
      })
      .map((path) => relative(srcRoot, path).replaceAll("\\", "/"))
      .sort();

    expect(actual).toEqual([...allowedRawSqlFiles].sort());
  });
});
