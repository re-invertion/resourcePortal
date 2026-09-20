import { HealthState, RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";
import { StackRuntimeService } from "./stack-runtime.service";

const appGroupId = "11111111-1111-4111-8111-111111111111";
const singleAppId = "22222222-2222-4222-8222-222222222222";

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

function candidate(id = appGroupId) {
  return {
    id,
    status: "Ready",
    runtimeState: RuntimeState.Running,
    currentDeploymentVersion: 3,
    updatedAt: new Date(),
    tenant: { status: "Active", billing: null },
    singleApps: [{ id: singleAppId, runtimeState: RuntimeState.Running }],
  };
}

function snapshot() {
  return JSON.stringify({
    singleApps: [
      {
        id: singleAppId,
        name: "web-api",
        image: "registry.example.test/web:3",
        desiredReplicas: 3,
      },
    ],
  });
}

function maintenance() {
  return {
    getState: vi.fn().mockResolvedValue({ enabled: false }),
  } as unknown as PlatformMaintenanceService;
}

describe("RuntimeDriftReconcilerService observed state", () => {
  it("persists normalized running/desired/image state and degrades health without auto-repair", async () => {
    const appGroupUpdate = vi
      .fn<(args: AppGroupObservedUpdate) => Promise<object>>()
      .mockResolvedValue({});
    const singleAppUpdateMany = vi
      .fn<(args: SingleAppObservedUpdate) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      appGroup: { update: appGroupUpdate },
      singleApp: { updateMany: singleAppUpdateMany },
    };
    const prisma = {
      appGroup: { findMany: vi.fn().mockResolvedValue([candidate()]), update: vi.fn() },
      appGroupDeployment: {
        findFirst: vi.fn().mockResolvedValue({ stackConfig: snapshot() }),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const runtime = {
      inspectStackServices: vi.fn().mockResolvedValue([
        {
          name: "rp_11111111_1111_4111_8111_111111111111_web_api",
          image: "registry.example.test/web:3@sha256:abc123",
          runningReplicas: 1,
          desiredReplicas: 3,
        },
      ]),
    } as unknown as StackRuntimeService;
    const service = new RuntimeDriftReconcilerService(prisma, runtime, maintenance());

    await expect(service.reconcileBatch()).resolves.toEqual({
      scanned: 1,
      inSync: 1,
      drifted: 0,
      unknown: 0,
    });

    const singleUpdate = singleAppUpdateMany.mock.calls[0]?.[0];
    expect(singleUpdate?.where).toEqual({ id: singleAppId, appGroupId });
    expect(singleUpdate?.data).toMatchObject({
      actualReplicas: 1,
      observedDesiredReplicas: 3,
      observedImage: "registry.example.test/web:3@sha256:abc123",
      health: HealthState.Degraded,
    });
    expect(singleUpdate?.data.observedAt).toBeInstanceOf(Date);

    const groupUpdate = appGroupUpdate.mock.calls[0]?.[0];
    expect(groupUpdate?.where).toEqual({ id: appGroupId });
    expect(groupUpdate?.data).toMatchObject({
      driftStatus: "InSync",
      health: HealthState.Degraded,
    });
    expect(groupUpdate?.data.lastObservedAt).toBeInstanceOf(Date);
  });

  it("keeps the last successful observation stale when Docker cannot be read", async () => {
    const setUnknown = vi.fn().mockResolvedValue({});
    const transaction = vi.fn();
    const prisma = {
      appGroup: {
        findMany: vi.fn().mockResolvedValue([candidate()]),
        update: setUnknown,
      },
      appGroupDeployment: {
        findFirst: vi.fn().mockResolvedValue({ stackConfig: snapshot() }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const runtime = {
      inspectStackServices: vi.fn().mockResolvedValue(null),
    } as unknown as StackRuntimeService;
    const service = new RuntimeDriftReconcilerService(prisma, runtime, maintenance());

    await expect(service.reconcileBatch()).resolves.toEqual({
      scanned: 1,
      inSync: 0,
      drifted: 0,
      unknown: 1,
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(setUnknown).toHaveBeenCalledWith({
      where: { id: appGroupId },
      data: { driftStatus: "Unknown" },
    });
  });

  it("pages through every deployed App Group during a full startup resync", async () => {
    const first = candidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const second = candidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([]);
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      appGroup: { findMany, update },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RuntimeDriftReconcilerService(
      prisma,
      { inspectStackServices: vi.fn() } as unknown as StackRuntimeService,
      maintenance(),
    );

    await expect(service.reconcileAll(1)).resolves.toEqual({
      scanned: 2,
      inSync: 0,
      drifted: 0,
      unknown: 2,
    });
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        currentDeploymentVersion: { not: null },
        id: { gt: first.id },
      },
      take: 1,
    });
  });
});
