import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { Stage11AppGroupsService } from "./stage11-app-groups.service";

const GiB = 1_073_741_824;
const appId = "00000000-0000-0000-0000-000000000373";
const tenantId = "00000000-0000-0000-0000-000000000374";

function quotaFixture() {
  const existing = [
    { id: appId, cpu: 1, memoryBytes: 3 * GiB, gpu: 0, desiredReplicas: 1 },
    { id: "other", cpu: 2, memoryBytes: 62 * GiB, gpu: 0, desiredReplicas: 1 },
  ];
  const tx = {
    quota: { findUnique: vi.fn().mockResolvedValue({
      cpu: 16, memoryBytes: 60n * BigInt(GiB), gpu: 1, maxSingleApps: 100,
    }) },
    singleApp: { findMany: vi.fn().mockResolvedValue(existing) },
  };
  const service = Object.create(Stage11AppGroupsService.prototype) as Stage11AppGroupsService;
  const checkMethod = Reflect.get(service, "assertStage11QuotaAllowsSingleAppChange") as (
    this: Stage11AppGroupsService,
    tx: unknown,
    tenant: string,
    next: { cpu: number; memoryBytes: number; gpu: number; desiredReplicas: number },
    replacingId?: string,
  ) => Promise<void>;
  const check = checkMethod.bind(service);
  return { tx, existing, check };
}

describe("SingleApp quota drift admission (#370)", () => {
  it("allows image/metadata-only edits when a reduced memory quota was already exceeded", async () => {
    const { tx, existing, check } = quotaFixture();
    await expect(check(tx, tenantId, existing[0], appId)).resolves.toBeUndefined();
  });

  it("allows decreasing reservations while over quota", async () => {
    const { tx, existing, check } = quotaFixture();
    await expect(check(tx, tenantId, {
      ...existing[0], memoryBytes: 2 * GiB,
    }, appId)).resolves.toBeUndefined();
  });

  it("rejects increasing memory in an already over-quota tenant", async () => {
    const { tx, existing, check } = quotaFixture();
    await expect(check(tx, tenantId, {
      ...existing[0], memoryBytes: 4 * GiB,
    }, appId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("still rejects net-new reservations and preserves CPU/GPU quotas", async () => {
    const { tx, existing, check } = quotaFixture();
    await expect(check(tx, tenantId, {
      cpu: 1, memoryBytes: GiB, gpu: 0, desiredReplicas: 1,
    })).rejects.toBeInstanceOf(ForbiddenException);

    await expect(check(tx, tenantId, {
      ...existing[0], cpu: 18,
    }, appId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(check(tx, tenantId, {
      ...existing[0], gpu: 2,
    }, appId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks updates when the previous reservation baseline disappeared", async () => {
    const { tx, existing, check } = quotaFixture();
    await expect(check(tx, tenantId, existing[0], "unknown-id")).rejects.toThrow(
      "SingleApp quota baseline is unavailable",
    );
  });
});
