import { HealthState, RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";
import { StackRuntimeService } from "./stack-runtime.service";


type SingleAppObservedUpdate = {
  where: { id: string; appGroupId: string };
  data: {
    actualReplicas: number;
    observedDesiredReplicas: number;
    observedImage: string;
    health: HealthState;
    observedAt: Date;
    [key: string]: unknown;
  };
};

type AppGroupObservedUpdate = {
  where: { id: string };
  data: {
    driftStatus: string;
    health: HealthState;
    lastObservedAt: Date;
    [key: string]: unknown;
  };
};

describe("RuntimeDriftReconcilerService platform maintenance", () => {
  it("uses persisted maintenance state when deriving desired runtime and observed health", async () => {
    const appGroupId = "00000000-0000-4000-8000-000000000101";
    const singleAppId = "00000000-0000-4000-8000-000000000102";
    const findMany = vi.fn().mockResolvedValue([
      {
        id: appGroupId,
        status: "Ready",
        runtimeState: RuntimeState.Running,
        currentDeploymentVersion: 1,
        updatedAt: new Date(),
        tenant: { status: "Active", billing: null },
        singleApps: [{ id: singleAppId, runtimeState: RuntimeState.Running }],
      },
    ]);
    const findFirst = vi.fn().mockResolvedValue({
      stackConfig: JSON.stringify({
        singleApps: [
          {
            id: singleAppId,
            name: "web",
            image: "nginx:latest",
            desiredReplicas: 1,
          },
        ],
      }),
    });
    const appGroupUpdate = vi
      .fn<(args: AppGroupObservedUpdate) => Promise<undefined>>()
      .mockResolvedValue(undefined);
    const singleAppUpdateMany = vi
      .fn<(args: SingleAppObservedUpdate) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      appGroup: { update: appGroupUpdate },
      singleApp: { updateMany: singleAppUpdateMany },
    };
    const prisma = {
      appGroup: { findMany, update: vi.fn() },
      appGroupDeployment: { findFirst },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const inspectStackServices = vi.fn().mockResolvedValue([
      {
        name: "rp_00000000_0000_4000_8000_000000000101_web",
        image: "nginx:latest",
        runningReplicas: 0,
        desiredReplicas: 1,
      },
    ]);
    const runtime = { inspectStackServices } as unknown as StackRuntimeService;
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
    const singleUpdate = singleAppUpdateMany.mock.calls[0]?.[0];
    expect(singleUpdate?.where).toEqual({ id: singleAppId, appGroupId });
    expect(singleUpdate?.data).toMatchObject({
      actualReplicas: 0,
      observedDesiredReplicas: 1,
      observedImage: "nginx:latest",
      health: HealthState.Healthy,
    });
    expect(singleUpdate?.data.observedAt).toBeInstanceOf(Date);

    const groupUpdate = appGroupUpdate.mock.calls[0]?.[0];
    expect(groupUpdate?.where).toEqual({ id: appGroupId });
    expect(groupUpdate?.data).toMatchObject({
      driftStatus: "Drifted",
      health: HealthState.Healthy,
    });
    expect(groupUpdate?.data.lastObservedAt).toBeInstanceOf(Date);
  });
});
