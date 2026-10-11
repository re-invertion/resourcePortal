import { Prisma, RuntimeState, TenantStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { BillingWorkerService } from "./billing-worker.service";
import { deployedComputeAllocation } from "./deployed-compute-allocation";
import type { BillingService } from "./billing.service";
import type { BillingUsageService } from "./billing-usage.service";
import type { PrismaService } from "../prisma/prisma.service";

const decimal = (v: string | number) => new Prisma.Decimal(v);
function stack(cpu="4", memoryBytes="2147483648", desiredReplicas=1) {
  return JSON.stringify({
    singleApps: [{
      id: "app-1", name: "web", runtimeState: "Running", desiredReplicas,
      resources: { cpu, memoryBytes, gpu: 0 },
    }],
  });
}
describe("Billing must use actual deployed app allocation (#257)", () => {
  it("reads immutable CPU/memory/replicas from successful deploy and ignores undeployed edits", () => {
    const allocation = deployedComputeAllocation(stack(), "app-1");
    expect(allocation?.desiredReplicas).toBe(1);
    expect(allocation?.cpu.eq(decimal(4))).toBe(true);
    expect(allocation?.memoryBytes).toBe(2147483648n);
    expect(deployedComputeAllocation(stack(), "app-new-undeloyed")).toBeNull();
    expect(() => deployedComputeAllocation("{broken", "app-1")).toThrow("BillingDeployedSnapshotInvalid");
  });
  it("bills one running replica at deployed allocation despite draft deletion, zero replica and reduced resources", async () => {
    const recordUsageCharge = vi.fn().mockResolvedValue({});
    const snapshot = stack();
    const prisma = {
      singleApp: { findMany: vi.fn().mockResolvedValue([{
        id: "app-1", cpu: decimal("0.01"), memoryBytes: 134217728n,
        desiredReplicas: 0, gpu: 0, pendingDeletion: true,
        runtimeState: RuntimeState.Running, actualReplicas: 1,
        appGroup: {
          id: "group-1", tenantId: "tenant-1", currentDeploymentVersion: 3,
          runtimeState: RuntimeState.Running,
          tenant: { status: TenantStatus.Active },
          deployments: [{ version: 3, stackConfig: snapshot }],
        },
      }]) },
      billingAccount: { findMany: vi.fn().mockResolvedValue([{
        tenantId: "tenant-1", balance: decimal(100),
      }]) },
      volume: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const billing = {
      assertActivePriceList: vi.fn().mockResolvedValue({
        id: "price1", version: 1,
        cpuCreditsPerVcpuHour: decimal(60),
        memoryCreditsPerGbHour: decimal(60),
        gpuCreditsPerGpuHour: decimal(60),
        storageCreditsPerGbHour: decimal(60),
      }),
    };
    const service = new BillingWorkerService(
      prisma as unknown as PrismaService,
      billing as unknown as BillingService,
      { recordUsageCharge } as unknown as BillingUsageService,
    );
    const start = new Date("2026-10-10T12:00:00Z");
    await service.reconcilePeriod(start, new Date("2026-10-10T12:01:00Z"));
    expect(recordUsageCharge).toHaveBeenCalledOnce();
    const input = recordUsageCharge.mock.calls[0][0] as {
      theoreticalCost: Prisma.Decimal; usage: Record<string, unknown>;
    };
    expect(input.usage).toMatchObject({
      actualReplicas: 1, billedReplicas: 1, desiredReplicas: 1,
      cpuPerReplica: "4", memoryBytesPerReplica: "2147483648",
    });
    expect(input.theoreticalCost.gt(4)).toBe(true);
  });
  it("prevents billing reconciliation if a previously deployed snapshot is missing", async () => {
    const service = new BillingWorkerService(
      { billingAccount: { findMany: vi.fn().mockResolvedValue([{ tenantId: "tenant-1", balance: decimal(100) }]) },
        singleApp: { findMany: vi.fn().mockResolvedValue([{
          id: "app-1", appGroup: { id: "group-1", tenantId: "tenant-1",
            currentDeploymentVersion: 5, deployments: [] },
        }]) },
      } as unknown as PrismaService,
      { assertActivePriceList: vi.fn().mockResolvedValue({}) } as unknown as BillingService,
      { recordUsageCharge: vi.fn() } as unknown as BillingUsageService,
    );
    await expect(service.reconcilePeriod(new Date(),new Date())).rejects.toThrow(
      "BillingCurrentDeploymentSnapshotMissing",
    );
  });
});
