import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE = "abcdefghijklmnopqrstuvwxy";
const OTHER_NODE = "zyxwvutsrqponmlkjihgfedcb";

function stackConfig() {
  return JSON.stringify({
    appGroup: {
      id: "group-1",
      tenantId: "tenant-1",
      runtimeState: "Running",
      runtimeDraftRevision: 1,
    },
    singleApps: [{
      id: "app-1",
      name: "gpu-app",
      image: "alpine:3.20",
      registryId: null,
      desiredReplicas: 1,
      runtimeState: "Running",
      resources: {
        cpu: "0.5",
        memoryBytes: "268435456",
        gpu: 1,
        gpuUuid: GPU,
        gpuNodeId: NODE,
      },
      environment: {},
      variables: [],
      configs: [],
      secrets: [],
      volumes: [],
      httpEndpoints: [],
      healthCheck: null,
      entrypoint: null,
      command: [],
      workingDir: null,
      user: null,
      readOnlyRootFilesystem: true,
      stopGracePeriodSeconds: 30,
      restartPolicy: {},
      updatePolicy: {},
    }],
  });
}

function serviceWithDevice(device: Record<string, unknown>) {
  const prisma = {
    appGroup: {
      findUnique: vi.fn().mockResolvedValue({
        status: "Ready",
        tenant: { status: "Active", quota: null },
      }),
    },
    gpuDevice: {
      findMany: vi.fn().mockResolvedValue([device]),
    },
  };
  const service = new DeploymentExecutionService(
    prisma as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return service as unknown as {
    validateDeploymentSnapshot: (deployment: {
      appGroupId: string;
      stackConfig: string;
    }) => Promise<{ success: boolean; errorCode?: string }>;
  };
}

function readyDevice(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    uuid: GPU,
    allocatedSingleAppId: "app-1",
    allocationState: "Allocated",
    observedState: "Available",
    lastObservedAt: now,
    remoteLocation: {
      swarmNodeId: NODE,
      status: "Ready",
      availability: "Active",
      gpuCount: 1,
      lastSeenAt: now,
    },
    ...overrides,
  };
}

describe("GPU deployment preflight (#368)", () => {
  it("accepts a fresh exclusive UUID on the same verified Swarm node", async () => {
    const validate = serviceWithDevice(readyDevice());

    await expect(validate.validateDeploymentSnapshot({
      appGroupId: "group-1",
      stackConfig: stackConfig(),
    })).resolves.toEqual({ success: true });
  });

  it("fails closed when the reserved UUID is now observed on a different Swarm node", async () => {
    const validate = serviceWithDevice(readyDevice({
      remoteLocation: {
        swarmNodeId: OTHER_NODE,
        status: "Ready",
        availability: "Active",
        gpuCount: 1,
        lastSeenAt: new Date(),
      },
    }));

    await expect(validate.validateDeploymentSnapshot({
      appGroupId: "group-1",
      stackConfig: stackConfig(),
    })).resolves.toMatchObject({
      success: false,
      errorCode: "GpuNotAvailable",
    });
  });

  it.each([
    ["no verified GPU capacity", { gpuCount: 0, lastSeenAt: new Date() }],
    ["stale Swarm node inventory", { gpuCount: 1, lastSeenAt: new Date(Date.now() - 121_000) }],
  ])("fails closed for %s", async (_name, remoteLocationOverrides) => {
    const validate = serviceWithDevice(readyDevice({
      remoteLocation: {
        swarmNodeId: NODE,
        status: "Ready",
        availability: "Active",
        ...remoteLocationOverrides,
      },
    }));

    await expect(validate.validateDeploymentSnapshot({
      appGroupId: "group-1",
      stackConfig: stackConfig(),
    })).resolves.toMatchObject({
      success: false,
      errorCode: "GpuNotAvailable",
    });
  });
});
