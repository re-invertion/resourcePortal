import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE = "abcdefghijklmnopqrstuvwxy";
const GROUP = "group-1";
const APP = "app-1";

function snapshot(gpu: unknown = 1, changes: Record<string, unknown> = {}) {
  return {
    appGroup: { id: GROUP, tenantId: "tenant-1", runtimeState: "Running" },
    singleApps: [{
      id: APP, name: "model", desiredReplicas: 1, runtimeState: "Running",
      resources: {
        gpu, gpuUuid: GPU, gpuNodeId: NODE, ...changes,
      },
    }],
  };
}

function device(changes: Record<string, unknown> = {}) {
  return {
    uuid: GPU, allocatedSingleAppId: APP, allocationState: "Allocated",
    observedState: "Available", lastObservedAt: new Date(),
    remoteLocation: {
      swarmNodeId: NODE, status: "Ready", availability: "Active",
      gpuCount: 1, lastSeenAt: new Date(),
    },
    ...changes,
  };
}

function setup(devices: unknown[] = [device()]) {
  const findMany = vi.fn().mockResolvedValue(devices);
  const applyStack = vi.fn().mockResolvedValue({
    command: "docker stack deploy", stackName: "rp_group",
    exitCode: 0, stdout: "ok", stderr: "",
  });
  const withScopedLogin = vi.fn(async (
    _targets: unknown,
    apply: (dockerConfigPath: string) => Promise<unknown>,
  ) => ({ auth: { success: true }, result: await apply("/tmp/scoped-config") }));
  const instance = Object.create(DeploymentExecutionService.prototype) as DeploymentExecutionService;
  Reflect.set(instance, "prisma", { gpuDevice: { findMany } });
  Reflect.set(instance, "stackApplyService", { applyStack });
  Reflect.set(instance, "stackRegistryAuth", { withScopedLogin });
  Reflect.set(instance, "resolveRegistryLogins",
    vi.fn().mockResolvedValue({ success: true, loginTargets: [] }));
  const apply = (source: unknown) => instance.applyDeploymentArtifactWithRegistryAuth(
    JSON.stringify(source),
    { stackName: "rp_group", renderedStack: "services: {}", artifactSha256: "sha",
      appGroupId: GROUP },
  );
  return { instance, findMany, applyStack, withScopedLogin, apply };
}

describe("historical GPU deployment artifact ownership (#378)", () => {
  it("denies rollback after stale allocation is freed", async () => {
    const ctx = setup([]);
    await expect(ctx.apply(snapshot())).resolves.toMatchObject({
      exitCode: 1, stderr: "GpuRollbackOwnershipNotVerified",
    });
    expect(ctx.applyStack).not.toHaveBeenCalled();
    expect(ctx.withScopedLogin).not.toHaveBeenCalled();
  });

  it("denies a persisted GPU UUID reassigned to another tenant", async () => {
    const ctx = setup([device({ allocatedSingleAppId: "other-app" })]);
    await expect(ctx.apply(snapshot())).resolves.toMatchObject({
      exitCode: 1, stderr: "GpuRollbackOwnershipNotVerified",
    });
    expect(ctx.applyStack).not.toHaveBeenCalled();
  });

  it("denies stale or mismatched Swarm GPU evidence", async () => {
    for (const row of [
      device({ observedState: "Unavailable" }),
      device({ lastObservedAt: new Date(0) }),
      device({ remoteLocation: { ...device().remoteLocation, swarmNodeId: "other-node" } }),
      device({ remoteLocation: { ...device().remoteLocation, lastSeenAt: new Date(0) } }),
    ]) {
      const ctx = setup([row]);
      await expect(ctx.apply(snapshot())).resolves.toMatchObject({
        exitCode: 1, stderr: "GpuRollbackOwnershipNotVerified",
      });
      expect(ctx.applyStack).not.toHaveBeenCalled();
    }
  });

  it("denies an invalid GPU source, missing UUID or foreign AppGroup", async () => {
    for (const candidate of [
      snapshot("1"),
      snapshot(1, { gpuUuid: null }),
      snapshot(1, { gpuNodeId: null }),
      { ...snapshot(), appGroup: { id: "different-group" } },
    ]) {
      const ctx = setup([device()]);
      await expect(ctx.apply(candidate)).resolves.toMatchObject({
        exitCode: 1, stderr: "GpuRollbackOwnershipNotVerified",
      });
      expect(ctx.applyStack).not.toHaveBeenCalled();
    }
  });

  it("reapplies only when current exclusive UUID ownership and node proof are fresh", async () => {
    const ctx = setup();
    await expect(ctx.apply(snapshot())).resolves.toMatchObject({
      exitCode: 0, stdout: "ok",
    });
    expect(ctx.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { uuid: { in: [GPU] } },
    }));
    expect(ctx.applyStack).toHaveBeenCalledOnce();
  });

  it("does not require a GPU census for a CPU-only historical artifact", async () => {
    const ctx = setup([]);
    await expect(ctx.apply(snapshot(0))).resolves.toMatchObject({ exitCode: 0 });
    expect(ctx.findMany).not.toHaveBeenCalled();
    expect(ctx.applyStack).toHaveBeenCalledOnce();
  });

  it("blocks the automatic rollback path, not merely the worker-recovery helper", async () => {
    const ctx = setup([device({ allocatedSingleAppId: "foreign-app" })]);
    const previous = {
      id: "rollback-1", appGroupId: GROUP, version: 1,
      stackConfig: JSON.stringify(snapshot()),
    };
    const recordEvent = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      gpuDevice: { findMany: ctx.findMany },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(previous) },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({
        appGroupDeployment: { update }, deploymentEvent: { create: recordEvent },
      }),
    };
    Reflect.set(ctx.instance, "prisma", prisma);
    Reflect.set(ctx.instance, "ensureDeploymentArtifact", vi.fn().mockResolvedValue({
      renderedStack: "services: {}", sha256: "sha",
    }));
    const markFailed = vi.fn().mockResolvedValue({ status: "RollbackFailed" });
    Reflect.set(ctx.instance, "markRollbackFailed", markFailed);
    Reflect.set(ctx.instance, "stackName", vi.fn().mockReturnValue("rp_group"));
    const rollback = Reflect.get(ctx.instance, "rollbackAfterRuntimeFailure") as
      (deployment: object, snapshot: object, message: string, details: string) => Promise<unknown>;
    await expect(rollback.call(ctx.instance, {
      id: "deployment-2", appGroupId: GROUP, version: 2, leaseOwner: "worker",
      leaseExpiresAt: null, stackConfig: JSON.stringify(snapshot()),
      sourceDraftRevision: 2,
    }, snapshot(0), "rollout failed", "runtime error")).resolves.toEqual({
      status: "RollbackFailed",
    });
    expect(markFailed).toHaveBeenCalledWith(
      "deployment-2", 1, expect.stringContaining("GpuRollbackOwnershipNotVerified"),
    );
    expect(ctx.applyStack).not.toHaveBeenCalled();
  });
});
