import { describe, expect, it, vi } from "vitest";
import { RuntimeState } from "@prisma/client";
import { RuntimeOperationExecutor } from "./runtime-operation.executor";
import type { PrismaService } from "../../prisma/prisma.service";
import type { StackRuntimeService } from "../../internal/stack-runtime.service";
import type { OperationRecord } from "../operation.types";

const appGroupId = "11111111-1111-4111-8111-111111111111";
const singleAppId = "22222222-2222-4222-8222-222222222222";
const operation = { type: "SINGLE_APP_RESTART", resourceId: singleAppId, input: { appGroupId } } as OperationRecord;

function fixture(stackConfig: string | null) {
  const findUnique = vi.fn().mockResolvedValue({
    id: appGroupId,
    runtimeState: RuntimeState.Running,
    currentDeploymentVersion: 1,
    singleApps: [{ id: singleAppId, name: "test", runtimeState: RuntimeState.Running, pendingDeletion: false, desiredReplicas: 1 }],
  });
  const findFirst = vi.fn().mockResolvedValue(stackConfig === null ? null : { stackConfig });
  const restartServices = vi.fn().mockResolvedValue([{ command: "docker service update", exitCode: 0, stderr: "", stdout: "" }]);
  const prisma = { appGroup: { findUnique }, appGroupDeployment: { findFirst } } as unknown as PrismaService;
  const runtime = { restartServices } as unknown as StackRuntimeService;
  return { executor: new RuntimeOperationExecutor(prisma, runtime), restartServices };
}

describe("SingleApp restart outcome (#365)", () => {
  it("never reports successful restart when there is no deployed Swarm service", async () => {
    const { executor, restartServices } = fixture(null);
    await expect(executor.execute(operation)).rejects.toMatchObject({ code: "RestartServiceUnavailable", retryable: false });
    expect(restartServices).not.toHaveBeenCalled();
  });
  it("returns unknown instead of failed when a force restart timed out after submission", async () => {
    const { executor, restartServices } = fixture(JSON.stringify({ singleApps: [{ id: singleAppId, name: "test" }] }));
    restartServices.mockResolvedValue([{ command: "docker service update", exitCode: 124, stdout: "", stderr: "timed out" }]);
    await expect(executor.execute(operation)).rejects.toMatchObject({ code: "RestartOutcomeUnknown", retryable: false });
  });

  it("does not report success when the app was stopped after being queued", async () => {
    const { executor, restartServices } = fixture(JSON.stringify({ singleApps: [{ id: singleAppId, name: "test" }] }));
    const prisma = (executor as unknown as { prisma: { appGroup: { findUnique: (args: unknown) => Promise<unknown> } } }).prisma;
    const existing = await prisma.appGroup.findUnique({ where: { id: appGroupId } }) as Record<string, unknown>;
    vi.spyOn(prisma.appGroup, "findUnique").mockResolvedValue({ ...existing, runtimeState: RuntimeState.Stopped });
    await expect(executor.execute(operation)).rejects.toMatchObject({ code: "RestartPreconditionChanged", retryable: false });
    expect(restartServices).not.toHaveBeenCalled();
  });

  it("requests a converged service update and reports the committed restart", async () => {
    const { executor, restartServices } = fixture(JSON.stringify({ singleApps: [{ id: singleAppId, name: "test" }] }));
    await expect(executor.execute(operation)).resolves.toMatchObject({ result: { restartedServices: 1 } });
    expect(restartServices).toHaveBeenCalledWith([{ stackName: "rp_11111111_1111_4111_8111_111111111111", serviceName: "test" }], true);
  });
});
