import { DeploymentPhase, DeploymentStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapacityPreflightService,
  type CapacityDeploymentSnapshot,
} from "./capacity-preflight.service";

function deploymentSnapshot(input?: {
  id?: string;
  cpu?: string;
  memoryBytes?: string;
  replicas?: number;
  volumeId?: string;
}): CapacityDeploymentSnapshot {
  return {
    appGroup: {
      id: input?.id ?? "00000000-0000-0000-0000-000000000101",
      tenantId: "00000000-0000-0000-0000-000000000201",
      runtimeState: "Running",
    },
    singleApps: [
      {
        runtimeState: "Running",
        desiredReplicas: input?.replicas ?? 1,
        resources: {
          cpu: input?.cpu ?? "2",
          memoryBytes: input?.memoryBytes ?? "2048",
          gpu: 0,
        },
        volumes: input?.volumeId ? [{ volumeId: input.volumeId }] : [],
      },
    ],
  };
}

function serializedSnapshot(snapshot: CapacityDeploymentSnapshot) {
  return JSON.stringify(snapshot);
}

describe("Stage 15 capacity preflight", () => {
  let queryRaw: ReturnType<typeof vi.fn>;
  let findDeployments: ReturnType<typeof vi.fn>;
  let findVolumes: ReturnType<typeof vi.fn>;
  let tx: Prisma.TransactionClient;
  let service: CapacityPreflightService;

  beforeEach(() => {
    queryRaw = vi.fn();
    findDeployments = vi.fn().mockResolvedValue([]);
    findVolumes = vi.fn().mockResolvedValue([]);
    tx = {
      $queryRaw: queryRaw,
      appGroupDeployment: { findMany: findDeployments },
      volume: { findMany: findVolumes },
    } as unknown as Prisma.TransactionClient;
    service = new CapacityPreflightService();
  });

  function platform(input?: {
    health?: string;
    cpuNano?: bigint;
    memoryBytes?: bigint;
    schedulableNodeCount?: bigint;
  }) {
    queryRaw
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([
        {
          health: input?.health ?? "Healthy",
          availableCpuNano: input?.cpuNano ?? 4_000_000_000n,
          availableMemoryBytes: input?.memoryBytes ?? 8_192n,
          schedulableNodeCount: input?.schedulableNodeCount ?? 1n,
        },
      ]);
  }

  it("returns PlatformUnavailable when Swarm inventory has not been reconciled", async () => {
    queryRaw
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "PlatformUnavailable",
    });
  });

  it("returns PlatformUnavailable for an unhealthy Swarm", async () => {
    platform({ health: "Unhealthy" });

    await expect(
      service.admitDeployment(tx, deploymentSnapshot()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "PlatformUnavailable",
    });
  });

  it("allows a degraded platform when remaining capacity is sufficient", async () => {
    platform({ health: "Degraded" });

    await expect(
      service.admitDeployment(tx, deploymentSnapshot()),
    ).resolves.toMatchObject({
      success: true,
      demand: { cpuNano: 2_000_000_000n, memoryBytes: 2_048n },
    });
  });

  it("returns InsufficientCapacity when projected CPU cannot fit", async () => {
    platform({ cpuNano: 1_000_000_000n });

    await expect(
      service.admitDeployment(tx, deploymentSnapshot()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
  });

  it("uses an admitted active deployment instead of the previous succeeded baseline", async () => {
    platform();
    const otherAppGroupId = "00000000-0000-0000-0000-000000000102";
    findDeployments.mockResolvedValue([
      {
        appGroupId: otherAppGroupId,
        version: 1,
        status: DeploymentStatus.Succeeded,
        phase: DeploymentPhase.Completed,
        stackConfig: serializedSnapshot(
          deploymentSnapshot({ id: otherAppGroupId, cpu: "3" }),
        ),
      },
      {
        appGroupId: otherAppGroupId,
        version: 2,
        status: DeploymentStatus.Deploying,
        phase: DeploymentPhase.PreparingArtifacts,
        stackConfig: serializedSnapshot(
          deploymentSnapshot({ id: otherAppGroupId, cpu: "1" }),
        ),
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ cpu: "2" })),
    ).resolves.toMatchObject({ success: true });
  });

  it("does not reserve capacity for another deployment still in Validating", async () => {
    platform({ cpuNano: 3_000_000_000n });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000103";
    findDeployments.mockResolvedValue([
      {
        appGroupId: otherAppGroupId,
        version: 1,
        status: DeploymentStatus.Deploying,
        phase: DeploymentPhase.Validating,
        stackConfig: serializedSnapshot(
          deploymentSnapshot({ id: otherAppGroupId, cpu: "3" }),
        ),
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ cpu: "2" })),
    ).resolves.toMatchObject({ success: true });
  });

  it("returns PlatformUnavailable when a referenced StorageBackend is in maintenance", async () => {
    platform();
    const volumeId = "00000000-0000-0000-0000-000000000301";
    findVolumes.mockResolvedValue([
      {
        id: volumeId,
        storageBackend: {
          id: "00000000-0000-0000-0000-000000000401",
          status: "Ready",
          health: "Healthy",
          maintenance: true,
          capacityTotal: 10_000n,
          capacityAvailable: 5_000n,
        },
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ volumeId })),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "PlatformUnavailable",
    });
  });
});
