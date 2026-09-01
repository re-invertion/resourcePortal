import { RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";
import { StackRuntimeService } from "./stack-runtime.service";

describe("RuntimeDriftReconcilerService platform maintenance", () => {
  it("uses persisted platform maintenance state when deriving runtime drift", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000101",
        status: "Ready",
        runtimeState: RuntimeState.Running,
        currentDeploymentVersion: 1,
        updatedAt: new Date(),
        tenant: { status: "Active", billing: null },
        singleApps: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            runtimeState: RuntimeState.Running,
          },
        ],
      },
    ]);
    const findFirst = vi.fn().mockResolvedValue({
      stackConfig: JSON.stringify({
        singleApps: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            name: "web",
            image: "nginx:latest",
            desiredReplicas: 1,
          },
        ],
      }),
    });
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      appGroup: { findMany, update },
      appGroupDeployment: { findFirst },
    } as unknown as PrismaService;
    const inspectStackServices = vi.fn().mockResolvedValue([
      {
        name: "rp_00000000_0000_4000_8000_000000000101_web",
        image: "nginx:latest",
        desiredReplicas: 1,
      },
    ]);
    const runtime = {
      inspectStackServices,
    } as unknown as StackRuntimeService;
    const getState = vi.fn().mockResolvedValue({
      enabled: true,
      reason: "DR recovery",
      updatedBy: null,
      updatedAt: new Date(),
    });
    const maintenance = { getState } as unknown as PlatformMaintenanceService;
    const service = new RuntimeDriftReconcilerService(
      prisma,
      runtime,
      maintenance,
    );

    await expect(service.reconcileBatch()).resolves.toEqual({
      scanned: 1,
      inSync: 0,
      drifted: 1,
      unknown: 0,
    });
    expect(getState).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-4000-8000-000000000101" },
      data: { driftStatus: "Drifted" },
    });
  });
});
