import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GPU_APP = { name: "model", id: "12345678-1234-4234-8234-123456789abc" };

describe("GPU allocation is retained until physical Swarm task cleanup", () => {
  it("does not commit release when an old NVIDIA task remains on any node", async () => {
    const prisma = {
      $transaction: vi.fn(),
      gpuDevice: { findMany: vi.fn().mockResolvedValue([
        { allocatedSingleApp: GPU_APP },
      ]) },
    };
    const rollout = {
      waitForRollout: vi.fn().mockResolvedValue({
        success: true, message: "Rollout completed", details: "All services ready",
      }),
      verifyRemovedGpuServiceTasks: vi.fn().mockResolvedValue(false),
    };
    const instance = Object.create(DeploymentExecutionService.prototype) as DeploymentExecutionService;
    Reflect.set(instance, "prisma", prisma);
    Reflect.set(instance, "stackRolloutService", rollout);
    Reflect.set(instance, "findWorkerDeploymentOrThrow", vi.fn().mockResolvedValue({
      id: "d-1", appGroupId: "12345678-1234-4234-8234-123456789abc",
      stackConfig: "{}", rollbackTargetVersion: null,
    }));
    Reflect.set(instance, "parseStackConfig", vi.fn().mockReturnValue({
      singleApps: [], appGroup: { name: "demo" },
    }));
    Reflect.set(instance, "stackName", vi.fn().mockReturnValue("rp_demo"));
    const fail = vi.fn().mockResolvedValue({ status: "RollingBack" });
    Reflect.set(instance, "rollbackAfterRuntimeFailure", fail);

    const response = await (instance as unknown as {
      waitForRollout: (deploymentId: string, workerId: string) => Promise<unknown>;
    }).waitForRollout("d-1", "worker-1");

    expect(response).toEqual({ status: "RollingBack" });
    expect(rollout.verifyRemovedGpuServiceTasks).toHaveBeenCalledWith(
      "rp_demo", ["model"],
    );
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d-1" }),
      expect.any(Object),
      "GPU runtime cleanup unverified",
      expect.stringContaining("Swarm node is unavailable"),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
