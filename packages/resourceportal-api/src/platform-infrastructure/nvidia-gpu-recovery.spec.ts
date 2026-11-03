import { describe, expect, it, vi } from "vitest";
import { DockerSwarmInfrastructureService } from "./docker-swarm-infrastructure.service";
import { NvidiaGpuAllocationService } from "./nvidia-gpu-allocation.service";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";
import { DeploymentExecutionService } from "../internal/deployment-execution.service";

const uuid = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const node = {
  swarmNodeId: "ku2gbq2sm1b2khra543dtyxfg", hostname: "worker-a",
  status: "Ready", availability: "Active", gpuUuids: [uuid],
};

function harness() {
  const docker = {
    inspectSwarm: vi.fn(),
    listNodes: vi.fn().mockResolvedValue([node]),
    verifyNoGpuSwarmServiceReservations: vi.fn().mockResolvedValue(true),
  };
  const probe = {
    collect: vi.fn().mockResolvedValue([{
      status: "Observed", swarmNodeId: node.swarmNodeId,
      devices: [{ uuid }],
    }]),
    collectUsage: vi.fn().mockResolvedValue([{
      status: "Verified", swarmNodeId: node.swarmNodeId,
      busyAnyGpu: false, containers: [],
    }]),
  };
  const allocation = {
    listInventory: vi.fn().mockResolvedValue([{
      uuid, allocationState: "Allocated", allocatedSingleAppId: "app-id",
      observedState: "Unavailable",
      node: { swarmNodeId: node.swarmNodeId },
    }]),
    adminReleaseStaleGpu: vi.fn().mockResolvedValue({
      released: true, uuid, singleAppId: "app-id",
    }),
  };
  const service = new SwarmInfrastructureService(
    {} as never, docker as never, {} as never, undefined,
    probe as never, allocation as never,
  );
  const actor = { id: "admin", displayName: "Admin", email: "admin@example.com" } as never;
  vi.spyOn(service, "reconcile").mockResolvedValue({ nodeCount: 1 } as never);
  return { service, docker, probe, allocation, actor };
}

describe("GPU verification diagnostics (#378)", () => {
  it("distinguishes missing named GenericResources from an unavailable NVIDIA runtime", async () => {
    const { service, docker, probe } = harness();
    docker.listNodes.mockResolvedValue([{ ...node, gpuUuids: [] }]);
    probe.collect.mockResolvedValue([{
      status: "Unavailable", swarmNodeId: node.swarmNodeId,
      devices: [], reason: "NvidiaNotDefaultRuntime",
    }]);
    const diagnosis = await service.diagnoseGpu(uuid);
    expect(diagnosis).toMatchObject({ verified: false, gpuCount: 0 });
    expect(diagnosis.reasonCodes).toContain("NvidiaNamedGenericResourceMissing");
    expect(diagnosis.reasonCodes).toContain("NvidiaNotDefaultRuntime");
  });

  it("distinguishes a successful probe with the wrong UUID", async () => {
    const { service, probe } = harness();
    probe.collect.mockResolvedValue([{
      status: "Observed", swarmNodeId: node.swarmNodeId,
      devices: [{ uuid: "GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }],
    }]);
    const diagnosis = await service.diagnoseGpu(uuid);
    expect(diagnosis.verified).toBe(false);
    expect(diagnosis.reasonCodes).toContain("GpuProbeUuidMismatch");
  });
});

describe("admin-only safe GPU recovery (#378)", () => {
  it("reprobes and preserves same owner reservation when ready", async () => {
    const { service, allocation, actor } = harness();
    vi.spyOn(service, "diagnoseGpu").mockResolvedValue({
      uuid, verified: true, reasonCodes: [],
    } as never);
    await expect(service.recoverGpu(uuid, actor)).resolves.toMatchObject({
      status: "ReadyForRedeploy", ownershipPreserved: true,
    });
    expect(allocation.adminReleaseStaleGpu).not.toHaveBeenCalled();
  });

  it("returns exact failure and never releases without explicit admin flag", async () => {
    const { service, allocation, actor } = harness();
    const diagnosis = { uuid, verified: false,
      allocatedSingleAppId: "app-id", reasonCodes: ["NvidiaNotDefaultRuntime"] };
    vi.spyOn(service, "diagnoseGpu").mockResolvedValue(diagnosis as never);
    await expect(service.recoverGpu(uuid, actor)).resolves.toMatchObject({
      status: "VerificationFailed", ownershipPreserved: true,
    });
    expect(allocation.adminReleaseStaleGpu).not.toHaveBeenCalled();
  });

  it("blocks release on missing, duplicate or GPU-occupied node evidence", async () => {
    const { service, allocation, probe, actor } = harness();
    vi.spyOn(service, "diagnoseGpu").mockResolvedValue({
      uuid, verified: false, allocatedSingleAppId: "app-id",
    } as never);
    probe.collectUsage.mockResolvedValue([]);
    await expect(service.recoverGpu(uuid, actor, true))
      .rejects.toThrow("GpuContainerCleanupNotVerified");
    probe.collectUsage.mockResolvedValue([{
      status: "Verified", swarmNodeId: node.swarmNodeId,
      busyAnyGpu: false, containers: [{ uuid, serviceName: "rp_group_gpu_app" }],
    }]);
    await expect(service.recoverGpu(uuid, actor, true))
      .rejects.toThrow("GpuContainerCleanupNotVerified");
    expect(allocation.adminReleaseStaleGpu).not.toHaveBeenCalled();
  });

  it("blocks release while any Swarm service could reschedule a GPU task", async () => {
    const { service, docker, allocation, actor } = harness();
    vi.spyOn(service, "diagnoseGpu").mockResolvedValue({
      uuid, verified: false, allocatedSingleAppId: "app-id",
    } as never);
    docker.verifyNoGpuSwarmServiceReservations.mockResolvedValue(false);
    await expect(service.recoverGpu(uuid, actor, true))
      .rejects.toThrow("GpuSwarmServiceStillReservesGpu");
    expect(allocation.adminReleaseStaleGpu).not.toHaveBeenCalled();
  });

  it("allows explicit release only after full absence proof", async () => {
    const { service, allocation, actor } = harness();
    vi.spyOn(service, "diagnoseGpu").mockResolvedValue({
      uuid, verified: false, allocatedSingleAppId: "app-id",
    } as never);
    await expect(service.recoverGpu(uuid, actor, true)).resolves.toMatchObject({
      status: "StaleAllocationReleased", released: { released: true, uuid },
    });
    expect(allocation.adminReleaseStaleGpu).toHaveBeenCalledWith(uuid, true, actor);
  });
});

describe("Swarm-wide GPU service reservation fence", () => {
  it("blocks safe release on any named or discrete NVIDIA-GPU resource", async () => {
    const docker = new DockerSwarmInfrastructureService({ get: () => undefined } as never);
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: "d".repeat(25) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({
        ContainerSpec: { Env: [] },
        Resources: { Reservations: { GenericResources: [{
          DiscreteResourceSpec: { Kind: "NVIDIA-GPU", Value: 1 },
        }] } },
      }) });
    (docker as unknown as { runDocker: typeof run }).runDocker = run;
    expect(await docker.verifyNoGpuSwarmServiceReservations()).toBe(false);
  });

  it("fails closed on Docker error and accepts verified CPU-only services", async () => {
    const docker = new DockerSwarmInfrastructureService({ get: () => undefined } as never);
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 1, stdout: "" });
    (docker as unknown as { runDocker: typeof run }).runDocker = run;
    expect(await docker.verifyNoGpuSwarmServiceReservations()).toBe(false);
    run.mockReset().mockResolvedValueOnce({ exitCode: 0, stdout: "d".repeat(25) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({
        ContainerSpec: { Env: ["NVIDIA_VISIBLE_DEVICES=void"] },
        Resources: { Reservations: {} },
      }) });
    expect(await docker.verifyNoGpuSwarmServiceReservations()).toBe(true);
  });
});

describe("transactional stale GPU release invariants", () => {
  it("never permits release without worker-verified runtime proof", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new NvidiaGpuAllocationService(prisma as never);
    await expect(service.adminReleaseStaleGpu(uuid, false, {} as never))
      .rejects.toThrow("GpuRuntimeCleanupRequired");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps a running owner reservation even with an empty runtime census", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      gpuDevice: { findUnique: vi.fn().mockResolvedValue({
        allocatedSingleAppId: "app-id", allocationState: "Allocated",
        observedState: "Unavailable",
      }), updateMany: vi.fn() },
      singleApp: { findUnique: vi.fn().mockResolvedValue({
        id: "app-id", runtimeState: "Running", appGroupId: "group-id",
        appGroup: { runtimeState: "Running", status: "Ready" },
      }) },
    };
    const service = new NvidiaGpuAllocationService({
      $transaction: (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
    } as never);
    await expect(service.adminReleaseStaleGpu(uuid, true, {} as never))
      .rejects.toThrow("GpuStopOwnerBeforeRelease");
    expect(tx.gpuDevice.updateMany).not.toHaveBeenCalled();
  });
});

describe("GPU disappears → reconcile → same-owner redeploy acceptance (#378)", () => {
  it("restores an existing allocation only after named resource and authenticated probe agree", async () => {
    const appId = "app-1", groupId = "group-1", tenantId = "tenant-1";
    const location = {
      id: "location-1", swarmNodeId: node.swarmNodeId,
      status: "Ready", availability: "Active", gpuCount: 0,
    };
    const device = {
      uuid, observedState: "Unavailable", allocationState: "Allocated",
      allocatedSingleAppId: appId, lastObservedAt: new Date(0),
    };
    const store = {
      listRemoteLocations: vi.fn().mockImplementation(() => Promise.resolve([location])),
      upsertRemoteLocation: vi.fn().mockImplementation((input: { gpuCount: number }) => {
        location.gpuCount = input.gpuCount;
        return Promise.resolve(location);
      }),
      saveCluster: vi.fn().mockResolvedValue({}),
    };
    const docker = {
      inspectSwarm: vi.fn().mockResolvedValue({ dockerClusterId: "cluster-1" }),
      listNodes: vi.fn().mockResolvedValue([{
        ...node, role: "Worker", cpuNano: 4_000_000_000n,
        memoryBytes: 8_589_934_592n, labels: {},
      }]),
    };
    const audit = { recordDiscovered: vi.fn(), recordRemoved: vi.fn() };
    const probe = { collect: vi.fn().mockResolvedValue([{
      swarmNodeId: node.swarmNodeId, status: "Observed",
      devices: [{ uuid }],
    }]) };
    const allocation = {
      observe: vi.fn().mockImplementation(() => {
        device.observedState = "Available";
        device.lastObservedAt = new Date();
        return Promise.resolve(device);
      }),
      markNodeUnavailable: vi.fn(),
      listInventory: vi.fn().mockImplementation(() => Promise.resolve([{
        ...device, node: { swarmNodeId: node.swarmNodeId },
      }])),
    };
    const infrastructure = new SwarmInfrastructureService(
      store as never, docker as never, audit as never,
      undefined, probe as never, allocation as never,
    );
    const recovered = await infrastructure.recoverGpu(uuid, {} as never);
    expect(recovered).toMatchObject({
      status: "ReadyForRedeploy", ownershipPreserved: true,
    });
    expect(location.gpuCount).toBe(1);
    expect(device.allocatedSingleAppId).toBe(appId);
    expect(device.observedState).toBe("Available");
    expect(allocation.observe).toHaveBeenCalledOnce();
    expect(allocation.markNodeUnavailable).not.toHaveBeenCalled();

    const prisma = {
      appGroup: { findUnique: vi.fn().mockResolvedValue({
        id: groupId, tenantId, status: "Ready",
        tenant: { status: "Active", quota: null },
      }) },
      gpuDevice: { findMany: vi.fn().mockResolvedValue([{
        ...device,
        remoteLocation: {
          swarmNodeId: node.swarmNodeId, status: "Ready",
          availability: "Active", gpuCount: location.gpuCount,
          lastSeenAt: new Date(),
        },
      }]) },
    };
    const deployment = new DeploymentExecutionService(
      prisma as never,
      undefined as never, undefined as never, undefined as never,
      undefined as never, undefined as never, undefined as never,
      undefined as never, undefined as never, undefined as never,
    ) as unknown as {
      validateDeploymentSnapshot: (input: { appGroupId: string; stackConfig: string }) =>
        Promise<{ success: boolean; errorCode?: string }>;
    };
    const snapshot = {
      appGroup: { id: groupId, tenantId, runtimeState: "Running" },
      singleApps: [{
        id: appId, name: "gpu-app", image: "alpine:3.20",
        registryId: null, desiredReplicas: 1, runtimeState: "Running",
        resources: {
          cpu: "0.5", memoryBytes: "268435456", gpu: 1,
          gpuUuid: uuid, gpuNodeId: node.swarmNodeId,
        },
        environment: {}, variables: [], configs: [], secrets: [],
        volumes: [], httpEndpoints: [], healthCheck: null,
        entrypoint: null, command: [], workingDir: null, user: null,
        readOnlyRootFilesystem: true, stopGracePeriodSeconds: 30,
        restartPolicy: {}, updatePolicy: {},
      }],
    };
    await expect(deployment.validateDeploymentSnapshot({
      appGroupId: groupId, stackConfig: JSON.stringify(snapshot),
    })).resolves.toEqual({ success: true });
  });
});

describe("GPU recovery transactional audit and idempotency (#378)", () => {
  function database(
    overrides: { activeDeployment?: boolean; alreadyFree?: boolean; concurrentLoss?: boolean } = {},
  ) {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      gpuDevice: {
        findUnique: vi.fn().mockResolvedValue({
          allocatedSingleAppId: overrides.alreadyFree ? null : "app-id",
          allocationState: overrides.alreadyFree ? "Free" : "Allocated",
          observedState: "Unavailable",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: overrides.concurrentLoss ? 0 : 1 }),
      },
      singleApp: {
        findUnique: vi.fn().mockResolvedValue({
          id: "app-id", appGroupId: "group-id", gpu: 1,
          runtimeState: "Stopped",
          appGroup: {
            runtimeState: "Stopped", status: "Ready",
            tenantId: "tenant-id", tenant: { name: "My tenant" },
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      appGroupDeployment: {
        findFirst: vi.fn().mockResolvedValue(
          overrides.activeDeployment ? { id: "deployment-id" } : null),
      },
      appGroup: { update: vi.fn().mockResolvedValue({}) },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new NvidiaGpuAllocationService({
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never);
    return { tx, service };
  }

  it("atomically releases only a stopped unavailable owner and writes tenant-scoped audit", async () => {
    const { tx, service } = database();
    const actor = { id: "admin-id", displayName: "Platform Admin" } as never;
    await expect(service.adminReleaseStaleGpu(uuid, true, actor)).resolves.toEqual({
      released: true, uuid, singleAppId: "app-id",
    });
    expect(tx.gpuDevice.updateMany).toHaveBeenCalledWith({
      where: {
        uuid, allocatedSingleAppId: "app-id",
        allocationState: "Allocated", observedState: { not: "Available" },
      },
      data: { allocatedSingleAppId: null, allocationState: "Free", allocatedAt: null },
    });
    expect(tx.singleApp.update).toHaveBeenCalledWith({
      where: { id: "app-id" }, data: { gpu: 0 },
    });
    expect(tx.appGroup.update).toHaveBeenCalledWith({
      where: { id: "group-id" },
      data: { hasPendingChanges: true, runtimeDraftRevision: { increment: 1 } },
    });
    const auditCall: unknown = tx.auditLogEntry.create.mock.calls[0]?.[0];
    expect(auditCall).toMatchObject({
      data: {
        actor: "admin-id", tenantId: "tenant-id", tenantName: "My tenant",
        action: "gpu.admin.stale_release", resourceId: "app-id",
      },
    });
  });

  it("is idempotent on a previously released GPU", async () => {
    const { tx, service } = database({ alreadyFree: true });
    await expect(service.adminReleaseStaleGpu(uuid, true, {} as never)).resolves.toEqual({
      released: false, uuid,
    });
    expect(tx.gpuDevice.updateMany).not.toHaveBeenCalled();
    expect(tx.singleApp.update).not.toHaveBeenCalled();
  });

  it("rejects active deployment and lost compare-and-swap before writing audit", async () => {
    const active = database({ activeDeployment: true });
    await expect(active.service.adminReleaseStaleGpu(uuid, true, {} as never))
      .rejects.toThrow("GpuDeploymentInProgress");
    expect(active.tx.gpuDevice.updateMany).not.toHaveBeenCalled();

    const lost = database({ concurrentLoss: true });
    await expect(lost.service.adminReleaseStaleGpu(uuid, true, {} as never))
      .rejects.toThrow("GpuRecoveryStateChanged");
    expect(lost.tx.singleApp.update).not.toHaveBeenCalled();
    expect(lost.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });
});
