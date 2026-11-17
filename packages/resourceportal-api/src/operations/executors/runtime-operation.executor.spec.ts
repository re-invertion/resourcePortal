import { describe, expect, it, vi } from "vitest";
import { RuntimeState } from "@prisma/client";
import { RuntimeOperationExecutor } from "./runtime-operation.executor";
import type { PrismaService } from "../../prisma/prisma.service";
import { classifyNewScaleTaskFailures, classifyScaleTaskFailure, type StackRuntimeService } from "../../internal/stack-runtime.service";
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
  const prisma = { appGroup: { findUnique }, appGroupDeployment: { findFirst } } as unknown as PrismaService;
  const runtime = { restartServices, scaleServices } as unknown as StackRuntimeService;
  return { executor: new RuntimeOperationExecutor(prisma, runtime), restartServices, scaleServices };
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


describe("runtime scale failure handling (#450)", () => {
  const deployed = JSON.stringify({ singleApps: [{ id: singleAppId, name: "test", desiredReplicas: 1 }] });
  const start = { type: "SINGLE_APP_START", resourceId: singleAppId, input: { appGroupId } } as OperationRecord;

  for (const code of ["ImagePullAuthorizationFailed", "ImageNotFound", "SwarmPlacementRejected"]) {
    it(`stops automatic retries on deterministic ${code}`, async () => {
      const { executor, scaleServices } = fixture(deployed);
      scaleServices.mockResolvedValue([{ command: "docker service scale", exitCode: 124,
        stdout: "", stderr: `Swarm scale did not converge; cause=${code}`, diagnosticCode: code }]);
      await expect(executor.execute(start)).rejects.toMatchObject({ code, retryable: false });
    });
  }

  it("does not blindly retry when a timed-out scale outcome cannot be classified", async () => {
    const { executor, scaleServices } = fixture(deployed);
    scaleServices.mockResolvedValue([{ command: "docker service scale", exitCode: 124,
      stdout: "", stderr: "Swarm scale did not converge; cause=TaskFailureUnknown", diagnosticCode: "TaskFailureUnknown" }]);
    await expect(executor.execute(start)).rejects.toMatchObject({ code: "RuntimeOutcomeUnknown", retryable: false });
  });
});


describe("bounded Swarm task error classification (#450)", () => {
  it("classifies registry authorization failure without copying secrets", () => {
    expect(classifyScaleTaskFailure("pull access denied: token=supersecret")).toBe("ImagePullAuthorizationFailed");
  });
  it("classifies missing image and capacity placement errors", () => {
    expect(classifyScaleTaskFailure("manifest unknown: image missing")).toBe("ImageNotFound");
    expect(classifyScaleTaskFailure("no suitable node (insufficient resources)")).toBe("SwarmPlacementRejected");
  });
  it("returns unknown instead of leaking unclassified task errors", () => {
    expect(classifyScaleTaskFailure("private user=alice token=secret")).toBe("TaskFailureUnknown");
  });
});


describe("Swarm task generation baseline (#450)", () => {
  const oldId = "abcdefghijklmnopqrstuvwxy";
  const newId = "zyxwvutsrqponmlkjihgfedcba";
  const row = (ID: string, Error: string, CurrentState = "Rejected 3 seconds ago") =>
    JSON.stringify({ ID, Error, CurrentState });

  it("does not attribute a prior private GHCR pull rejection to the next scale attempt", () => {
    expect(classifyNewScaleTaskFailures(oldId, row(oldId, "pull access denied")))
      .toBe("TaskFailureUnknown");
  });
  it("classifies only a fresh rejected task, ignoring an older different failure", () => {
    const errors = [row(oldId, "manifest unknown"), row(newId, "pull access denied")].join("\n");
    expect(classifyNewScaleTaskFailures(oldId, errors)).toBe("ImagePullAuthorizationFailed");
  });
  it("returns Unknown if no newly rejected task can be authenticated", () => {
    expect(classifyNewScaleTaskFailures(oldId, row(newId, "pull access denied", "Running 2 seconds ago")))
      .toBe("TaskFailureUnknown");
    expect(classifyNewScaleTaskFailures("invalid id", row(newId, "pull access denied")))
      .toBe("TaskFailureUnknown");
    expect(classifyNewScaleTaskFailures(oldId, "{bad json"))
      .toBe("TaskFailureUnknown");
    expect(classifyNewScaleTaskFailures(oldId, "x".repeat(65_537)))
      .toBe("TaskFailureUnknown");
  });
});
