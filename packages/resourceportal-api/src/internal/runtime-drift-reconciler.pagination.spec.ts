import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { StackRuntimeService } from "./stack-runtime.service";
import type { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";

describe("runtime restore reconciles beyond legacy 500-group cap (#268)", () => {
  it("scans 501 groups in stable keyset pages without repeating or dropping any", async () => {
    const all = Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(6, "0") }));
    const findMany = vi.fn(({ where, orderBy, take }: {
      where: { id?: { gt: string } }; orderBy: { id: string }; take: number;
    }) => {
      expect(orderBy).toEqual({ id: "asc" });
      expect(take).toBeLessThanOrEqual(500);
      return Promise.resolve(all.filter(group => !where.id || group.id > where.id.gt).slice(0, take));
    });
    const prisma = { appGroup: { findMany } };
    const service = new RuntimeDriftReconcilerService(
      prisma as unknown as PrismaService,
      {} as StackRuntimeService,
      { getState: vi.fn().mockResolvedValue({ enabled: false }) } as unknown as PlatformMaintenanceService,
    );
    const scanned: string[] = [];
    // The production reconcileCandidates loop is tested by its own service
    // suite. Here we isolate and verify the previously missing pagination.
    vi.spyOn(service as unknown as {
      reconcileCandidates: (groups: typeof all, maintenance: boolean) => Promise<{
        scanned: number; inSync: number; drifted: number; unknown: number;
      }>;
    }, "reconcileCandidates").mockImplementation(groups => {
      scanned.push(...groups.map(group => group.id));
      return Promise.resolve({ scanned: groups.length, inSync: groups.length, drifted: 0, unknown: 0 });
    });
    expect(await service.reconcileAll(100)).toEqual({
      scanned: 501, inSync: 501, drifted: 0, unknown: 0,
    });
    expect(findMany).toHaveBeenCalledTimes(6);
    expect(scanned).toEqual(all.map(group => group.id));
    expect(new Set(scanned).size).toBe(501);
  });
});
