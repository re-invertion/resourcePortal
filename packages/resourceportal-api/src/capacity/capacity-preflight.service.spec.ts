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
  let findLatestDeployment: ReturnType<typeof vi.fn>;
  let findVolumes: ReturnType<typeof vi.fn>;
  let findAppGroup: ReturnType<typeof vi.fn>;
  let findSingleApps: ReturnType<typeof vi.fn>;
  let tx: Prisma.TransactionClient;
  let service: CapacityPreflightService;

  beforeEach(() => {
    queryRaw = vi.fn();
    findDeployments = vi.fn().mockResolvedValue([]);
    findLatestDeployment = vi.fn().mockResolvedValue(null);
    findVolumes = vi.fn().mockResolvedValue([]);
    findAppGroup = vi.fn().mockResolvedValue(null);
    findSingleApps = vi.fn().mockResolvedValue([]);
    tx = {
      $queryRaw: queryRaw,
      appGroupDeployment: {
        findMany: findDeployments,
        findFirst: findLatestDeployment,
      },
      volume: { findMany: findVolumes },
      appGroup: { findUnique: findAppGroup },
      singleApp: { findMany: findSingleApps },
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

  it("counts a workload started after its succeeded snapshot was Stopped", async () => {
    platform({ cpuNano: 4_000_000_000n });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000104";
    const otherSingleAppId = "00000000-0000-0000-0000-000000000204";
    findDeployments.mockResolvedValue([
      {
        appGroupId: otherAppGroupId,
        version: 1,
        status: DeploymentStatus.Succeeded,
        phase: DeploymentPhase.Completed,
        stackConfig: JSON.stringify({
          appGroup: {
            id: otherAppGroupId,
            tenantId: "00000000-0000-0000-0000-000000000202",
            runtimeState: "Stopped",
          },
          singleApps: [
            {
              id: otherSingleAppId,
              runtimeState: "Running",
              desiredReplicas: 3,
              resources: { cpu: "1", memoryBytes: "1024", gpu: 0 },
              volumes: [],
            },
          ],
        }),
      },
    ]);
    findAppGroup.mockResolvedValue({
      id: otherAppGroupId,
      runtimeState: "Running",
    });
    findSingleApps.mockResolvedValue([
      {
        id: otherSingleAppId,
        runtimeState: "Running",
        desiredReplicas: 3,
        actualReplicas: 3,
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ cpu: "2" })),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
  });

  it("rejects a direct AppGroup runtime start when its deployed demand cannot fit", async () => {
    platform({ cpuNano: 2_000_000_000n });
    const appGroupId = "00000000-0000-0000-0000-000000000105";
    const singleAppId = "00000000-0000-0000-0000-000000000205";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "00000000-0000-0000-0000-000000000201",
          runtimeState: "Stopped",
        },
        singleApps: [
          {
            id: singleAppId,
            runtimeState: "Running",
            desiredReplicas: 1,
            resources: { cpu: "3", memoryBytes: "1024", gpu: 0 },
            volumes: [],
          },
        ],
      }),
    });
    findAppGroup.mockResolvedValue({ id: appGroupId, runtimeState: "Stopped" });
    findSingleApps.mockResolvedValue([
      {
        id: singleAppId,
        runtimeState: "Running",
        desiredReplicas: 1,
        actualReplicas: 0,
      },
    ]);

    const runtimeAdmission = service as unknown as {
      admitRuntimeStart: (
        client: Prisma.TransactionClient,
        input: { appGroupId: string },
      ) => Promise<unknown>;
    };

    await expect(
      runtimeAdmission.admitRuntimeStart(tx, { appGroupId }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
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