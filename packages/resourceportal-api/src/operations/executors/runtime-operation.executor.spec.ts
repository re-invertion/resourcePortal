import { describe, expect, it, vi } from "vitest";
import { RuntimeState } from "@prisma/client";
import { RuntimeOperationExecutor } from "./runtime-operation.executor";
import type { PrismaService } from "../../prisma/prisma.service";
import type { StackRuntimeService } from "../../internal/stack-runtime.service";
import type { OperationRecord } from "../operation.types";

const appGroupId = "11111111-1111-4111-8111-111111111111";
const singleAppId = "22222222-2222-4222-8222-222222222222";
const operation = { type: "SINGLE_APP_RESTART", resourceId: singleAppId, input: { appGroupId } } as OperationRecord;

function fixture(stackConfig: string | null, draftReplicas = 1) {
  const findUnique = vi.fn().mockResolvedValue({
    id: appGroupId,
    runtimeState: RuntimeState.Running,
    currentDeploymentVersion: 1,
    singleApps: [{ id: singleAppId, name: "test", runtimeState: RuntimeState.Running, pendingDeletion: false, desiredReplicas: draftReplicas }],
  });
  const findFirst = vi.fn().mockResolvedValue(stackConfig === null ? null : { stackConfig });
  const restartServices = vi.fn().mockResolvedValue([{ command: "docker service update", exitCode: 0, stderr: "", stdout: "" }]);
  const scaleServices = vi.fn().mockResolvedValue([{ command: "docker service scale", exitCode: 0, stderr: "", stdout: "" }]);
  const updateGroup = vi.fn().mockResolvedValue({});
  const updateApp = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = { appGroup: { findUnique, update: updateGroup }, singleApp: { updateMany: updateApp }, appGroupDeployment: { findFirst } } as unknown as PrismaService;
  const runtime = { restartServices, scaleServices } as unknown as StackRuntimeService;
  return { executor: new RuntimeOperationExecutor(prisma, runtime), restartServices, scaleServices, updateGroup, updateApp };
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


describe("Runtime start reservation consistency (#373 P1)", () => {
  const deployed = JSON.stringify({ singleApps: [{ id: singleAppId, name: "test", desiredReplicas: 1 }] });

  it("starts SingleApp using deployed replicas, not undeployed draft growth", async () => {
    const { executor, scaleServices } = fixture(deployed, 10);
    await expect(executor.execute({ type: "SINGLE_APP_START", resourceId: singleAppId,
      input: { appGroupId } } as OperationRecord)).resolves.toMatchObject({ result: { replicas: 1 } });
    expect(scaleServices).toHaveBeenCalledWith([expect.objectContaining({
      singleAppId, replicas: 1,
    })]);
  });

  it("starts AppGroup using the succeeded snapshot even if draft is scaled to zero", async () => {
    const { executor, scaleServices } = fixture(deployed, 0);
    await expect(executor.execute({ type: "APP_GROUP_START", resourceId: appGroupId,
      input: { appGroupId } } as OperationRecord)).resolves.toMatchObject({ result: { scaledServices: 1 } });
    expect(scaleServices).toHaveBeenCalledWith([expect.objectContaining({
      singleAppId, replicas: 1,
    })]);
  });

  it("fails closed on missing deployed replica count instead of applying a draft", async () => {
    const { executor, scaleServices } = fixture(JSON.stringify({ singleApps: [{ id: singleAppId, name: "test" }] }), 10);
    await expect(executor.execute({ type: "SINGLE_APP_START", resourceId: singleAppId,
      input: { appGroupId } } as OperationRecord)).rejects.toMatchObject({
        code: "DeploymentSnapshotInvalid", retryable: false,
      });
    expect(scaleServices).not.toHaveBeenCalled();
  });
});

describe("Swarm scale failure classification (#450)", () => {
  const deployed = JSON.stringify({ singleApps: [{ id: singleAppId, name: "test", desiredReplicas: 1 }] });
  const start = { type: "SINGLE_APP_START", resourceId: singleAppId, input: { appGroupId } } as OperationRecord;

  it("reports private image authorization failure without blind retries", async () => {
    const { executor, scaleServices } = fixture(deployed);
    scaleServices.mockResolvedValue([{ command: "docker service scale", exitCode: 124, stderr: "ImagePullAuthorizationFailed", stdout: "" }]);
    await expect(executor.execute(start)).rejects.toMatchObject({
      code: "ImagePullAuthorizationFailed", retryable: false,
    });
  });

  it("does not repeat a timed-out scale while its outcome is unknown", async () => {
    const { executor, scaleServices } = fixture(deployed);
    scaleServices.mockResolvedValue([{ command: "docker service scale", exitCode: 124, stderr: "SwarmScaleOutcomeUnknown", stdout: "" }]);
    await expect(executor.execute(start)).rejects.toMatchObject({
      code: "ScaleOutcomeUnknown", retryable: false,
    });
  });

  it("does not retry a missing image without operator correction", async () => {
    const { executor, scaleServices } = fixture(deployed);
    scaleServices.mockResolvedValue([{ command: "docker service scale", exitCode: 1, stderr: "ImageNotFound", stdout: "" }]);
    await expect(executor.execute(start)).rejects.toMatchObject({
      code: "ImageNotFound", retryable: false,
    });
  });
});


it("invalidates stale Healthy readings before submitting a SingleApp start (#450)", async () => {
  const deployed = JSON.stringify({ singleApps: [{ id: singleAppId, name: "test", desiredReplicas: 1 }] });
  const { executor, scaleServices, updateApp, updateGroup } = fixture(deployed);
  await executor.execute({ type: "SINGLE_APP_START", resourceId: singleAppId, input: { appGroupId } } as OperationRecord);
  expect(updateApp).toHaveBeenCalledWith(expect.objectContaining({
    data: { health: "Unknown" },
  }));
  expect(updateGroup).toHaveBeenCalledWith(expect.objectContaining({
    data: { health: "Unknown", driftStatus: "Unknown" },
  }));
  expect(updateApp.mock.invocationCallOrder[0]).toBeLessThan(scaleServices.mock.invocationCallOrder[0]);
});
