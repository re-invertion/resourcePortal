import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const APP = "12345678-1234-4234-8234-123456789abc";
const GROUP = "12345678-1234-4234-8234-123456789abd";
const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function scenario(options: {
  verified: boolean;
  draftRevision?: number;
  activeGpu?: boolean;
}) {
  const deployment = {
    id: "deployment-526",
    appGroupId: GROUP,
    version: 8,
    stackConfig: "{}",
    rollbackTargetVersion: null,
    sourceDraftRevision: 8,
  };
  const app = {
    id: APP, name: "source", runtimeState: "Running", desiredReplicas: 1,
    resources: { gpu: 0 },
    healthCheck: {},
  };
  const device = {
    uuid: GPU, allocatedSingleAppId: APP,
    allocatedSingleApp: { name: "source" },
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    singleApp: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    gpuDevice: { updateMany },
    appGroup: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        runtimeDraftRevision: options.draftRevision ?? 8,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    appGroupDeployment: {
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...deployment, ...data })),
    },
    deploymentEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    gpuDevice: { findMany: vi.fn().mockImplementation(({ where }) =>
      Promise.resolve(where.allocatedSingleApp.pendingDeletion ? [] : [device])) },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx)),
  };
  const rollout = {
    waitForRollout: vi.fn().mockResolvedValue({
      success: true, message: "Rollout completed", details: "1/1 replicas",
    }),
    verifyDetachedGpuServiceTasks: vi.fn().mockResolvedValue(options.verified),
  };
  const service = Object.create(DeploymentExecutionService.prototype) as DeploymentExecutionService;
  Reflect.set(service, "prisma", prisma);
  Reflect.set(service, "stackRolloutService", rollout);
  Reflect.set(service, "findWorkerDeploymentOrThrow", vi.fn().mockResolvedValue(deployment));
  Reflect.set(service, "parseStackConfig", vi.fn().mockReturnValue({
    appGroup: { id: GROUP, name: "group" },
    singleApps: [options.activeGpu ? {
      ...app, resources: { gpu: 1, gpuUuid: GPU },
    } : app],
  }));
  Reflect.set(service, "stackName", vi.fn().mockReturnValue("rp_group"));
  Reflect.set(service, "serviceName", vi.fn().mockReturnValue("source"));
  Reflect.set(service, "effectiveReplicas", vi.fn().mockReturnValue(1));
  Reflect.set(service, "renderHealthCheck", vi.fn().mockReturnValue(undefined));
  Reflect.set(service, "createDeploymentEvent", vi.fn().mockResolvedValue(undefined));
  const rollback = vi.fn().mockResolvedValue({ status: "RollingBack" });
  Reflect.set(service, "rollbackAfterRuntimeFailure", rollback);
  return { service, tx, prisma, rollout, rollback, updateMany };
}

async function complete(service: DeploymentExecutionService) {
  return (service as unknown as {
    waitForRollout: (id: string, worker: string) => Promise<{status: DeploymentStatus}>;
  }).waitForRollout("deployment-526", "worker-526");
}

describe("GPU ownership release on successful gpu:0 deployment (#526)", () => {
  it("releases old ownership only after runtime detach proof and completes deployment", async () => {
    const { service, updateMany, rollout, tx } = scenario({ verified: true });
    const result = await complete(service);
    expect(result.status).toBe(DeploymentStatus.Succeeded);
    expect(rollout.verifyDetachedGpuServiceTasks).toHaveBeenCalledWith("rp_group", ["source"]);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        uuid: GPU, allocatedSingleAppId: APP, allocationState: "Allocated",
      }),
      data: {
        allocatedSingleAppId: null, allocationState: "Free", allocatedAt: null,
      },
    }));
    expect(tx.appGroupDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phase: DeploymentPhase.Completed }),
    }));
  });

  it("fails closed when the old GPU task cannot be proven detached", async () => {
    const { service, updateMany, rollback, prisma } = scenario({ verified: false });
    expect(await complete(service)).toEqual({ status: "RollingBack" });
    expect(rollback).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      "GPU runtime detach unverified", expect.any(String),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("preserves a reservation when a concurrent draft edit changed revision", async () => {
    const { service, updateMany } = scenario({ verified: true, draftRevision: 9 });
    expect((await complete(service)).status).toBe(DeploymentStatus.Succeeded);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not release allocation of a GPU-backed snapshot", async () => {
    const { service, updateMany, rollout } = scenario({ verified: true, activeGpu: true });
    expect((await complete(service)).status).toBe(DeploymentStatus.Succeeded);
    expect(updateMany).not.toHaveBeenCalled();
    expect(rollout.verifyDetachedGpuServiceTasks).not.toHaveBeenCalled();
  });
});
