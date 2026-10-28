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
  // Global GPU allocation advisory lock serializes draft discard with reservations.
  "app-groups/app-groups.service.ts",
  // Global GPU allocation lock protects verified rollout deletion/release.
  "internal/deployment-execution.service.ts",
  // Atomic GPU UUID reservation and cross-node ownership reconciliation.
  "platform-infrastructure/nvidia-gpu-allocation.service.ts",
  // Reviewed tenant usage time-series aggregate with bounded bucket choices.
  "billing/billing-read.service.ts",
  // Atomic usage dedupe plus BillingAccount row locking.
  "billing/billing-usage.service.ts",
  // Price-list advisory lock, Voucher/BillingAccount FOR UPDATE.
  "billing/billing.service.ts",
  // Platform capacity snapshot + advisory mutation lock.
  "capacity/capacity-preflight.service.ts",
  // PostgreSQL transaction-scoped advisory lock serializes refresh-token rotation
  // across API replicas; parameter is safely bound via Prisma.sql.
  "auth/auth-session.service.ts",
  // Minimal SELECT 1 readiness probe.
  "health/health.controller.ts",
  // Atomic mirrored Operation + OperationEvent creation in caller transaction.
  "operations/deployment-operation-adapter.service.ts",
  // Global GPU reservation lock: release only after every Swarm node is clean.
  "operations/executors/app-group-delete-operation.executor.ts",
  // SKIP LOCKED claim/lease CAS and idempotent Operation state transitions.
  "operations/operations.repository.ts",
  // BillingAccount FOR UPDATE protects ResourceBot reservation and settlement races.
  "resource-bot/resource-bot-billing.service.ts",
  // Cross-replica atomic fixed-window upsert.
  "security/rate-limit.service.ts",
  // PostgreSQL sequence, advisory capacity lock, COALESCE reservation aggregate,
  // and compare-and-set resize reservation.
  "storage-backends/storage-backend.store.ts",
  // Tenant quota advisory transaction lock.
  "tenants/quota-concurrency.ts",
  // Reviewed parameter-bound Tenant row lock serializes grant reconciliation,
  // OIDC disable/revoke and membership removal across replicated API workers.
  "tenant-oidc/tenant-oidc.service.ts",
  // Tenant owner row lock serializes owner-role removals.
  "tenants/tenants.service.ts",
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
