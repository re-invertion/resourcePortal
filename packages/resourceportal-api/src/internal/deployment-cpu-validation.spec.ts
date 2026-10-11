import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

describe("deployment CPU safety (#252)", () => {
  it.each(["0", "-1", "0.001", "129", "not-a-number"])(
    "rejects CPU allocation %s in a persisted worker snapshot even with no quota",
    async (cpu) => {
      const prisma = {
        appGroup: { findUnique: vi.fn().mockResolvedValue({
          status: "Ready", tenant: { status: "Active", quota: null },
        }) },
      };
      const service = new DeploymentExecutionService(
        prisma as never,
        undefined as never, undefined as never, undefined as never,
        undefined as never, undefined as never, undefined as never,
        undefined as never, undefined as never, undefined as never,
      );
      const validate = service as unknown as {
        validateDeploymentSnapshot: (deployment: { appGroupId: string; stackConfig: string }) => Promise<unknown>;
      };
      const stackConfig = JSON.stringify({
        appGroup: { id: "group-1", tenantId: "tenant-1", runtimeState: "Running" },
        singleApps: [{
          id: "app-1", name: "unbounded", image: "nginx",
          desiredReplicas: 1, runtimeState: "Running",
          resources: { cpu, memoryBytes: "134217728", gpu: 0 },
        }],
      });
      await expect(validate.validateDeploymentSnapshot({
        appGroupId: "group-1", stackConfig,
      })).resolves.toMatchObject({
        success: false, errorCode: "InvalidCpuAllocation",
      });
    },
  );
});
