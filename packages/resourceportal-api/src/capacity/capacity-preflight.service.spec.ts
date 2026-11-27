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
    schedulableNodeIds?: string[];
  }) {
    queryRaw
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([
        {
          health: input?.health ?? "Healthy",
          availableCpuNano: input?.cpuNano ?? 4_000_000_000n,
          availableMemoryBytes: input?.memoryBytes ?? 8_192n,
          schedulableNodeCount: input?.schedulableNodeCount ?? 1n,
          schedulableNodeIds:
            input?.schedulableNodeIds ??
            ["ku2gbq2sm1b2khra543dtyxfg"],
        },
      ]);
  }

  it("filters both CPU and memory supply to the same schedulable inventory", async () => {
    platform();
    await service.admitDeployment(tx, deploymentSnapshot());
    const sql = (queryRaw.mock.calls[1][0] as Prisma.Sql).sql;
    for (const resource of ["availableCpuNano", "availableMemoryBytes"]) {
      const start = sql.indexOf('SUM(r."' + resource + '") FILTER');
      expect(start).toBeGreaterThanOrEqual(0);
      const filter = sql.slice(start, sql.indexOf('), 0)', start));
      expect(filter).toContain("r.\"status\" = 'Ready'");
      expect(filter).toContain("r.\"availability\" = 'Active'");
      expect(filter).toContain('r."maintenance" = false');
      expect(filter).toContain("r.\"health\" IN ('Healthy', 'Degraded')");
    }
  });

  it.each(["start-first", "stop-first"] as const)(
    "accounts for an existing candidate with %s order",
    async order => {
      platform({ cpuNano: 8_000_000_000n, memoryBytes: 3_072n });
      const snapshot = deploymentSnapshot();
      snapshot.singleApps[0].id = "existing-app";
      snapshot.singleApps[0].name = "existing-app";
      snapshot.singleApps[0].updatePolicy = { order };
      findLatestDeployment.mockResolvedValue({ stackConfig: serializedSnapshot(snapshot) });
      const result = await service.admitDeployment(tx, snapshot);
      expect(result.success).toBe(order === "stop-first");
      if (result.success) expect(result.demand.memoryBytes).toBe(2_048n);
    },
  );

  it.each(["rename", "reverse-start-first"] as const)("reserves both stacks for %s", async scenario => {
    platform({ cpuNano: 8_000_000_000n, memoryBytes: 3_072n });
    const old = deploymentSnapshot();
    Object.assign(old.singleApps[0], { id: "existing", name: "old-name", updatePolicy: { order: scenario === "rename" ? "stop-first" : "start-first" } });
    const target = structuredClone(old);
    target.singleApps[0].updatePolicy = { order: "stop-first" };
    if (scenario === "rename") target.singleApps[0].name = "new-name";
    findLatestDeployment.mockResolvedValue({ stackConfig: serializedSnapshot(old) });
    await expect(service.admitDeployment(tx, target)).resolves.toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
  });

  it("does not offset a growing stop-first service against a shrinking service", async () => {
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 6_144n });
    const old = deploymentSnapshot({ cpu: "1", memoryBytes: "4096" });
    old.singleApps[0].id = "app-a";
    old.singleApps[0].updatePolicy = { order: "stop-first" };
    old.singleApps.push({
      ...old.singleApps[0], id: "app-b",
      resources: { ...old.singleApps[0].resources, memoryBytes: "1024" },
    });
    const target = { ...old, singleApps: old.singleApps.map((app, index) => ({
      ...app, resources: { ...app.resources, memoryBytes: index === 0 ? "1024" : "4096" },
    })) };
    findLatestDeployment.mockResolvedValue({ stackConfig: serializedSnapshot(old) });
    await expect(service.admitDeployment(tx, target)).resolves.toMatchObject({
      success: false, errorCode: "InsufficientCapacity",
    });
  });

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

  it("rejects an inconsistent schedulable node identity inventory", async () => {
    platform({
      schedulableNodeCount: 2n,
      schedulableNodeIds: ["ku2gbq2sm1b2khra543dtyxfg"],
    });

    const result = await service.admitDeployment(tx, deploymentSnapshot());

    expect(result).toMatchObject({
      success: false,
      errorCode: "PlatformUnavailable",
    });
    if (result.success) return;
    expect(result.message).toContain("identity inventory is inconsistent");
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

  it("keeps the previous succeeded allocation until an active smaller rollout completes", async () => {
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
    ).resolves.toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
  });

  it.each([DeploymentStatus.RollingBack, DeploymentStatus.RollbackFailed])("retains concurrent reservation during %s until newer success", async status => {
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 6_144n });
    const id = "other-group";
    const previous = deploymentSnapshot({ id, cpu: "1", memoryBytes: "4096" });
    const target = deploymentSnapshot({ id, cpu: "1", memoryBytes: "2048" });
    findDeployments.mockResolvedValue([
      { appGroupId: id, version: 1, status: DeploymentStatus.Succeeded, phase: DeploymentPhase.Completed, stackConfig: serializedSnapshot(previous) },
      { appGroupId: id, version: 2, status, phase: status === DeploymentStatus.RollingBack ? DeploymentPhase.RollingBack : DeploymentPhase.Completed, stackConfig: serializedSnapshot(target) },
    ]);
    await expect(service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "1024" }))).resolves.toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
  });

  it.each([DeploymentPhase.ApplyingStack, DeploymentPhase.WaitingForRollout, DeploymentPhase.Validating])("retains failed deployment reservations only after possible application (%s)", async phase => {
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 3_072n });
    const id = "other-group";
    findDeployments.mockResolvedValue([{
      appGroupId: id, version: 1, status: DeploymentStatus.Failed, phase,
      stackConfig: serializedSnapshot(deploymentSnapshot({ id, cpu: "1", memoryBytes: "2048" })),
    }]);
    const result = await service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2048" }));
    expect(result.success).toBe(phase === DeploymentPhase.Validating);
  });

  it("does not exclude unresolved reservations belonging to the candidate group", async () => {
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 3_072n });
    const target = deploymentSnapshot({ cpu: "1", memoryBytes: "2048" });
    findDeployments.mockResolvedValue([{
      appGroupId: target.appGroup.id, version: 1, status: DeploymentStatus.RollbackFailed, phase: DeploymentPhase.Completed,
      stackConfig: serializedSnapshot(target),
    }]);
    await expect(service.admitDeployment(tx, target)).resolves.toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
  });

  it("retains all unresolved failed rollback versions until a newer success", async () => {
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 7_168n });
    const id = "other-group";
    const row = (version: number, status: DeploymentStatus, memoryBytes: string) => ({
      appGroupId: id, version, status, phase: DeploymentPhase.Completed,
      stackConfig: serializedSnapshot(deploymentSnapshot({ id, cpu: "1", memoryBytes })),
    });
    findDeployments.mockResolvedValue([
      row(1, DeploymentStatus.Succeeded, "2048"),
      row(2, DeploymentStatus.RollbackFailed, "2048"),
      row(3, DeploymentStatus.RollbackFailed, "2048"),
    ]);
    await expect(service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2048" }))).resolves.toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 7_168n });
    findDeployments.mockResolvedValue([
      row(1, DeploymentStatus.Succeeded, "2048"),
      row(2, DeploymentStatus.RollbackFailed, "2048"),
      row(3, DeploymentStatus.RollbackFailed, "2048"),
      row(4, DeploymentStatus.Succeeded, "2048"),
    ]);
    await expect(service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2048" }))).resolves.toMatchObject({ success: true, occupied: { memoryBytes: 2048n } });
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

  it("keeps a stopping workload reserved while actual replicas are still running", async () => {
    platform({ cpuNano: 4_000_000_000n });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000106";
    const otherSingleAppId = "00000000-0000-0000-0000-000000000206";
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
            runtimeState: "Running",
          },
          singleApps: [
            {
              id: otherSingleAppId,
              runtimeState: "Running",
              desiredReplicas: 1,
              resources: { cpu: "3", memoryBytes: "1024", gpu: 0 },
              volumes: [],
            },
          ],
        }),
      },
    ]);
    findAppGroup.mockResolvedValue({ runtimeState: "Stopped" });
    findSingleApps.mockResolvedValue([
      {
        id: otherSingleAppId,
        runtimeState: "Running",
        desiredReplicas: 1,
        actualReplicas: 1,
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ cpu: "2" })),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
  });

  it("releases a stopped workload after actual replicas reach zero", async () => {
    platform({ cpuNano: 4_000_000_000n });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000107";
    const otherSingleAppId = "00000000-0000-0000-0000-000000000207";
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
            runtimeState: "Running",
          },
          singleApps: [
            {
              id: otherSingleAppId,
              runtimeState: "Running",
              desiredReplicas: 1,
              resources: { cpu: "3", memoryBytes: "1024", gpu: 0 },
              volumes: [],
            },
          ],
        }),
      },
    ]);
    findAppGroup.mockResolvedValue({ runtimeState: "Stopped" });
    findSingleApps.mockResolvedValue([
      {
        id: otherSingleAppId,
        runtimeState: "Running",
        desiredReplicas: 1,
        actualReplicas: 0,
      },
    ]);

    await expect(
      service.admitDeployment(tx, deploymentSnapshot({ cpu: "2" })),
    ).resolves.toMatchObject({ success: true });
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

    await expect(
      service.admitRuntimeStart(tx, { appGroupId }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
  });

  it("rejects a direct SingleApp runtime start when its deployed demand cannot fit", async () => {
    platform({ cpuNano: 2_000_000_000n });
    const appGroupId = "00000000-0000-0000-0000-000000000108";
    const singleAppId = "00000000-0000-0000-0000-000000000208";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "00000000-0000-0000-0000-000000000201",
          runtimeState: "Running",
        },
        singleApps: [
          {
            id: singleAppId,
            runtimeState: "Stopped",
            desiredReplicas: 1,
            resources: { cpu: "3", memoryBytes: "1024", gpu: 0 },
            volumes: [],
          },
        ],
      }),
    });
    findAppGroup.mockResolvedValue({ id: appGroupId, runtimeState: "Running" });
    findSingleApps.mockResolvedValue([
      {
        id: singleAppId,
        runtimeState: "Stopped",
        desiredReplicas: 1,
        actualReplicas: 0,
      },
    ]);

    await expect(
      service.admitRuntimeStart(tx, { appGroupId, singleAppId }),
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

  it("does not count undeployed draft replica growth as occupied CPU or RAM (#373)", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 4_000_000_000n, memoryBytes: 8n * GiB });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000113";
    const otherSingleAppId = "00000000-0000-0000-0000-000000000213";
    findDeployments.mockResolvedValue([{
      appGroupId: otherAppGroupId,
      version: 1,
      status: DeploymentStatus.Succeeded,
      phase: DeploymentPhase.Completed,
      stackConfig: JSON.stringify({
        ...deploymentSnapshot({ id: otherAppGroupId, cpu: "1", memoryBytes: String(3n * GiB) }),
        singleApps: [{
          id: otherSingleAppId,
          runtimeState: "Running",
          desiredReplicas: 1,
          resources: { cpu: "1", memoryBytes: String(3n * GiB), gpu: 1 },
          volumes: [],
        }],
      }),
    }]);
    findAppGroup.mockResolvedValue({ runtimeState: "Running" });
    findSingleApps.mockResolvedValue([{
      id: otherSingleAppId,
      runtimeState: "Running",
      desiredReplicas: 25, // draft-only update; not deployed
      actualReplicas: 1,
    }]);

    await expect(service.admitDeployment(tx, deploymentSnapshot({
      cpu: "1", memoryBytes: String(3n * GiB + GiB / 4n),
    }))).resolves.toMatchObject({
      success: true,
      occupied: { cpuNano: 1_000_000_000n, memoryBytes: 3n * GiB },
    });
  });

  it("reserves snapshot replicas when starting a stopped group despite a zero-replica draft", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 2_000_000_000n, memoryBytes: 2n * GiB });
    const appGroupId = "00000000-0000-0000-0000-000000000114";
    const singleAppId = "00000000-0000-0000-0000-000000000214";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: { id: appGroupId, tenantId: "00000000-0000-0000-0000-000000000201", runtimeState: "Stopped" },
        singleApps: [{
          id: singleAppId,
          runtimeState: "Running",
          desiredReplicas: 3,
          resources: { cpu: "1", memoryBytes: String(GiB), gpu: 0 },
          volumes: [],
        }],
      }),
    });
    findAppGroup.mockResolvedValue({ runtimeState: "Stopped" });
    findSingleApps.mockResolvedValue([{
      id: singleAppId, runtimeState: "Running", desiredReplicas: 0, actualReplicas: 0,
    }]);

    await expect(service.admitRuntimeStart(tx, { appGroupId })).resolves.toMatchObject({
      success: false,
      errorCode: "InsufficientCapacity",
    });
  });

  it("explains aggregate reserved, requested, and allocatable memory without exposing tenants", async () => {
    platform({ cpuNano: 4_000_000_000n, memoryBytes: 8_192n });
    const otherAppGroupId = "00000000-0000-0000-0000-000000000115";
    findDeployments.mockResolvedValue([{
      appGroupId: otherAppGroupId,
      version: 1,
      status: DeploymentStatus.Succeeded,
      phase: DeploymentPhase.Completed,
      stackConfig: serializedSnapshot(deploymentSnapshot({ id: otherAppGroupId, cpu: "1", memoryBytes: "7000" })),
    }]);

    const result = await service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2000" }));
    expect(result).toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
    if (result.success) throw new Error("expected rejection");
    expect(result.message).toContain("requested=2000 bytes");
    expect(result.message).toContain("reserved=7000 bytes");
    expect(result.message).toContain("allocatable=8192 bytes");
    expect(result.message).toContain("unreserved=1192 bytes");
    expect(result.message).not.toContain(otherAppGroupId);
  });


  it("admits a group start at its deployed replica target despite an undeployed draft increase (#373 P1)", async () => {
    platform({ cpuNano: 2_000_000_000n, memoryBytes: 8_192n });
    const appGroupId = "00000000-0000-0000-0000-000000000116";
    const singleAppId = "00000000-0000-0000-0000-000000000216";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: { id: appGroupId, tenantId: "00000000-0000-0000-0000-000000000201", runtimeState: "Stopped" },
        singleApps: [{
          id: singleAppId, runtimeState: "Running", desiredReplicas: 1,
          resources: { cpu: "1", memoryBytes: "1024", gpu: 0 }, volumes: [],
        }],
      }),
    });
    findAppGroup.mockResolvedValue({ runtimeState: "Stopped" });
    findSingleApps.mockResolvedValue([{
      id: singleAppId, runtimeState: "Running", desiredReplicas: 10, actualReplicas: 0,
    }]);

    await expect(service.admitRuntimeStart(tx, { appGroupId })).resolves.toMatchObject({
      success: true, demand: { cpuNano: 1_000_000_000n, memoryBytes: 1024n },
    });
  });

  it("uses deployed replicas for SingleApp start despite an undeployed draft increase (#373 P1)", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 10_000_000_000n, memoryBytes: 3n * GiB });
    const appGroupId = "00000000-0000-0000-0000-000000000117";
    const singleAppId = "00000000-0000-0000-0000-000000000217";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: { id: appGroupId, tenantId: "00000000-0000-0000-0000-000000000201", runtimeState: "Running" },
        singleApps: [{
          id: singleAppId, runtimeState: "Stopped", desiredReplicas: 1,
          resources: { cpu: "1", memoryBytes: String(GiB), gpu: 0 }, volumes: [],
        }],
      }),
    });
    findAppGroup.mockResolvedValue({ runtimeState: "Running" });
    findSingleApps.mockResolvedValue([{
      id: singleAppId, runtimeState: "Stopped", desiredReplicas: 4, actualReplicas: 0,
    }]);

    await expect(service.admitRuntimeStart(tx, { appGroupId, singleAppId })).resolves.toMatchObject({
      success: true, demand: { cpuNano: 1_000_000_000n, memoryBytes: GiB },
    });
  });

  it("retains the admitted snapshot reservation for a subsequent deployment before reconciliation (#373 P1)", async () => {
    platform({ cpuNano: 10_000_000_000n, memoryBytes: 16_384n });
    const appGroupId = "00000000-0000-0000-0000-000000000118";
    const singleAppId = "00000000-0000-0000-0000-000000000218";
    findDeployments.mockResolvedValue([{
      appGroupId, version: 1, status: DeploymentStatus.Succeeded,
      phase: DeploymentPhase.Completed,
      stackConfig: JSON.stringify({
        appGroup: { id: appGroupId, tenantId: "00000000-0000-0000-0000-000000000202", runtimeState: "Stopped" },
        singleApps: [{ id: singleAppId, runtimeState: "Running", desiredReplicas: 1,
          resources: { cpu: "1", memoryBytes: "1024", gpu: 0 }, volumes: [] }],
      }),
    }]);
    // A start was committed, but the observed replica count is still stale.
    // The executor must scale only the one deployed replica (tested separately).
    findAppGroup.mockResolvedValue({ runtimeState: "Running" });
    findSingleApps.mockResolvedValue([{
      id: singleAppId, runtimeState: "Running", desiredReplicas: 10, actualReplicas: 0,
    }]);
    await expect(service.admitDeployment(tx, deploymentSnapshot({ cpu: "9", memoryBytes: "1024" })))
      .resolves.toMatchObject({
        success: true, occupied: { cpuNano: 1_000_000_000n, memoryBytes: 1024n },
      });
  });

  describe("Hybrid deployable budget (#500)", () => {
    it("returns no budget when telemetry is stale", async () => {
      queryRaw.mockResolvedValueOnce([{ health: "Healthy", availableCpuNano: 4_000_000_000n, availableMemoryBytes: 8_192n, schedulableNodeCount: 1n, schedulableNodeIds: ["ku2gbq2sm1b2khra543dtyxfg"] }]);
      const evaluateAdmission = vi.fn().mockResolvedValue({ usable: false, reason: "fresh worker-published Hybrid admission telemetry is unavailable" });
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      await expect(service.hybridBudget(tx)).resolves.toBeNull();
      expect(evaluateAdmission).toHaveBeenCalledOnce();
    });

    it("serializes the limiting-node budget after growth and in-flight demand", async () => {
      queryRaw.mockResolvedValueOnce([{ health: "Healthy", availableCpuNano: 4_000_000_000n, availableMemoryBytes: 8_192n, schedulableNodeCount: 1n, schedulableNodeIds: ["ku2gbq2sm1b2khra543dtyxfg"] }]);
      const GiB = 1_073_741_824n;
      const evaluateAdmission = vi.fn().mockResolvedValue({ usable: true, decision: {
        deployableHeadroomBytes: 15n * GiB,
        predictedExistingGrowthBytes: 16n * GiB,
        inFlightPredictedBytes: GiB,
        allowed: true, reason: "test",
      } });
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      await expect(service.hybridBudget(tx)).resolves.toMatchObject({
        deployableHeadroomBytes: (15n * GiB).toString(),
        predictedExistingGrowthBytes: (16n * GiB).toString(),
        inFlightPredictedBytes: GiB.toString(),
        allowed: true,
      });
    });
  });

  describe("Hybrid strict-fallback diagnostics (#409)", () => {
    function nearLimitReservation() {
      platform({ cpuNano: 10_000_000_000n, memoryBytes: 8_192n });
      const otherAppGroupId = "00000000-0000-0000-0000-000000000409";
      findDeployments.mockResolvedValue([{
        appGroupId: otherAppGroupId,
        version: 1,
        status: DeploymentStatus.Succeeded,
        phase: DeploymentPhase.Completed,
        stackConfig: serializedSnapshot(deploymentSnapshot({
          id: otherAppGroupId, cpu: "1", memoryBytes: "7000",
        })),
      }]);
    }

    it.each(["invalid JSON", JSON.stringify({
      appGroup: { id: "other-group", runtimeState: "Running" },
      singleApps: [{ runtimeState: "Running", desiredReplicas: -1, resources: { memoryBytes: "1024" }, volumes: [] }],
    })])("rejects unreadable in-flight reservations before evaluating Hybrid capacity (%s)", async invalidSnapshot => {
      platform();
      findDeployments.mockResolvedValueOnce([]).mockResolvedValueOnce([{ stackConfig: invalidSnapshot }]);
      const evaluateAdmission = vi.fn();
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      await expect(service.admitDeployment(tx, deploymentSnapshot())).resolves.toMatchObject({
        success: false, errorCode: "PlatformUnavailable",
      });
      expect(evaluateAdmission).not.toHaveBeenCalled();
    });

    it("admits a stopped GPU assignment with healthy evidence but denies stale evidence (#533)", async () => {
      const GiB = 1_073_741_824n;
      const candidate = deploymentSnapshot({ cpu: "4", memoryBytes: String(10n * GiB) });
      candidate.singleApps = [
        { ...candidate.singleApps[0], id: "running-source", desiredReplicas: 1 },
        { ...candidate.singleApps[0], id: "stopped-destination", runtimeState: "Stopped", desiredReplicas: 1,
          resources: { cpu: "5", memoryBytes: String(24n * GiB), gpu: 1 } },
      ];
      platform({ cpuNano: 10_000_000_000n, memoryBytes: 67_417_341_952n });
      platform({ cpuNano: 10_000_000_000n, memoryBytes: 67_417_341_952n });
      const occupied = [{ appGroupId: "other-group", version: 1,
        status: DeploymentStatus.Succeeded, phase: DeploymentPhase.Completed,
        stackConfig: serializedSnapshot(deploymentSnapshot({ id: "other-group", cpu: "1", memoryBytes: "60129542144" })),
      }];
      findDeployments.mockResolvedValueOnce(occupied).mockResolvedValueOnce([])
        .mockResolvedValueOnce(occupied).mockResolvedValueOnce([]);
      const evaluateAdmission = vi.fn().mockResolvedValueOnce({ usable: true, decision: { allowed: true } })
        .mockResolvedValueOnce({ usable: false, reason: "fresh worker-published Hybrid admission telemetry is unavailable" });
      service = new CapacityPreflightService({ evaluateAdmission } as never, { current: () => ({ mode: "Hybrid" }) } as never);
      await expect(service.admitDeployment(tx, candidate)).resolves.toMatchObject({ success: true, demand: { memoryBytes: 10n * GiB } });
      const stale = await service.admitDeployment(tx, candidate);
      expect(stale).toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
      if (!stale.success) expect(stale.message).toContain("WorkerTelemetryUnavailableOrStale");
    });

    it.each(["healthy", "stale"] as const)("accounts for two unchanged stop-first services (#534, %s)", async evidence => {
      const GiB = 1_073_741_824n;
      platform({ cpuNano: 20_000_000_000n, memoryBytes: 67_417_341_952n });
      const old = deploymentSnapshot({ cpu: "1", memoryBytes: String(2n * GiB) });
      old.singleApps[0].id = "wrapper";
      old.singleApps[0].name = "wrapper";
      old.singleApps[0].updatePolicy = { order: "stop-first" };
      old.singleApps.push({ ...old.singleApps[0], id: "browser", name: "browser" });
      findLatestDeployment.mockResolvedValue({ stackConfig: serializedSnapshot(old) });
      findDeployments.mockResolvedValueOnce([{
        appGroupId: "other-group", version: 1, status: DeploymentStatus.Succeeded, phase: DeploymentPhase.Completed,
        stackConfig: serializedSnapshot(deploymentSnapshot({ id: "other-group", cpu: "1", memoryBytes: String(60n * GiB) })),
      }]);
      const evaluateAdmission = vi.fn().mockResolvedValue(evidence === "healthy"
        ? { usable: true, decision: { allowed: true } }
        : { usable: false, reason: "fresh worker-published Hybrid admission telemetry is unavailable" });
      service = new CapacityPreflightService({ evaluateAdmission } as never, { current: () => ({ mode: "Hybrid" }) } as never);
      const result = await service.admitDeployment(tx, old);
      expect(result.success).toBe(evidence === "healthy");
      if (result.success) expect(result.demand.memoryBytes).toBe(4n * GiB);
      else expect(result.message).toContain("WorkerTelemetryUnavailableOrStale");
    });

    it("reports telemetry unavailable/stale reason without bypassing strict reservation limits", async () => {
      nearLimitReservation();
      const evaluateAdmission = vi.fn().mockResolvedValue({
        usable: false,
        reason: "fresh worker-published Hybrid admission telemetry is unavailable",
      });
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      const result = await service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2000" }));
      expect(evaluateAdmission).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ success: false, errorCode: "InsufficientCapacity" });
      if (result.success) throw new Error("expected conservative denial");
      expect(result.message).toContain("admissionMode=StrictFallback");
      expect(result.message).toContain("reason=WorkerTelemetryUnavailableOrStale");
      expect(result.message).toContain("unreserved=1192 bytes");
    });

    it("identifies missing node coverage and never echoes untrusted telemetry reasons", async () => {
      nearLimitReservation();
      service = new CapacityPreflightService(
        { evaluateAdmission: vi.fn().mockResolvedValue({
          usable: false,
          reason: "node tenant-id sensitive arbitrary failure",
        }) } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      const result = await service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2000" }));
      if (result.success) throw new Error("expected denial");
      expect(result.message).toContain("reason=HybridEvidenceUnavailable");
      expect(result.message).not.toContain("tenant-id sensitive");
    });

    it("explains a missing telemetry service under Hybrid mode", async () => {
      nearLimitReservation();
      service = new CapacityPreflightService(
        undefined,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      const result = await service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2000" }));
      if (result.success) throw new Error("expected denial");
      expect(result.message).toContain("reason=TelemetryServiceUnavailable");
    });

    it("uses a healthy Hybrid admission decision instead of rejecting high declared reservations", async () => {
      nearLimitReservation();
      const evaluateAdmission = vi.fn().mockResolvedValue({ usable: true, decision: { allowed: true } });
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      await expect(service.admitDeployment(tx, deploymentSnapshot({ cpu: "1", memoryBytes: "2000" })))
        .resolves.toMatchObject({ success: true });
      expect(evaluateAdmission).toHaveBeenCalledOnce();
    });

    it("keeps CPU admission strict regardless of Hybrid telemetry", async () => {
      platform({ cpuNano: 1_000_000_000n });
      const evaluateAdmission = vi.fn();
      service = new CapacityPreflightService(
        { evaluateAdmission } as never,
        { current: () => ({ mode: "Hybrid" }) } as never,
      );
      const result = await service.admitDeployment(tx, deploymentSnapshot());
      if (result.success) throw new Error("expected CPU denial");
      expect(result.message).toContain("platform cpu capacity");
      expect(result.message).not.toContain("StrictFallback");
      expect(evaluateAdmission).not.toHaveBeenCalled();
    });
  });

  it("passes an effective deployed AppGroup start target to Hybrid admission", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 10_000_000_000n, memoryBytes: 32n * GiB });
    const appGroupId = "00000000-0000-0000-0000-000000000119";
    const singleAppId = "00000000-0000-0000-0000-000000000219";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "00000000-0000-0000-0000-000000000201",
          runtimeState: "Stopped",
        },
        singleApps: [{
          id: singleAppId,
          runtimeState: "Running",
          desiredReplicas: 3,
          resources: { cpu: "1", memoryBytes: String(GiB), gpu: 0 },
          volumes: [],
        }],
      }),
    });
    findAppGroup.mockResolvedValue({ runtimeState: "Stopped" });
    findSingleApps
      .mockResolvedValueOnce([{
        id: singleAppId,
        runtimeState: "Running",
        desiredReplicas: 10,
        actualReplicas: 0,
      }])
      .mockResolvedValueOnce([{
        id: singleAppId,
        runtimeState: "Running",
        actualReplicas: 0,
      }])
      .mockResolvedValueOnce([]);

    let capturedSnapshot: CapacityDeploymentSnapshot | undefined;
    const evaluateAdmission = vi.fn(
      (input: { snapshot: CapacityDeploymentSnapshot }) => {
        capturedSnapshot = input.snapshot;
        return Promise.resolve({
          usable: true,
          decision: { allowed: true },
          predictions: [],
          requestedPredictedBytes: 3n * GiB,
          reason: "test",
        });
      },
    );
    service = new CapacityPreflightService(
      { evaluateAdmission } as never,
      { current: () => ({ mode: "Hybrid" }) } as never,
    );

    await expect(
      service.admitRuntimeStart(tx, { appGroupId }),
    ).resolves.toMatchObject({ success: true });

    expect(evaluateAdmission).toHaveBeenCalledOnce();
    expect(capturedSnapshot).toMatchObject({
      appGroup: { runtimeState: "Running" },
      singleApps: [{
        id: singleAppId,
        runtimeState: "Running",
        desiredReplicas: 3,
      }],
    });
  });

  it("passes an effective deployed SingleApp start target to Hybrid admission", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 10_000_000_000n, memoryBytes: 32n * GiB });
    const appGroupId = "00000000-0000-0000-0000-000000000120";
    const singleAppId = "00000000-0000-0000-0000-000000000220";
    findLatestDeployment.mockResolvedValue({
      stackConfig: JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "00000000-0000-0000-0000-000000000201",
          runtimeState: "Running",
        },
        singleApps: [{
          id: singleAppId,
          runtimeState: "Stopped",
          desiredReplicas: 2,
          resources: { cpu: "1", memoryBytes: String(GiB), gpu: 0 },
          volumes: [],
        }],
      }),
    });
    findAppGroup.mockResolvedValue({ runtimeState: "Running" });
    findSingleApps
      .mockResolvedValueOnce([{
        id: singleAppId,
        runtimeState: "Stopped",
        desiredReplicas: 7,
        actualReplicas: 0,
      }])
      .mockResolvedValueOnce([{
        id: singleAppId,
        runtimeState: "Stopped",
        actualReplicas: 0,
      }])
      .mockResolvedValueOnce([]);

    let capturedSnapshot: CapacityDeploymentSnapshot | undefined;
    const evaluateAdmission = vi.fn(
      (input: { snapshot: CapacityDeploymentSnapshot }) => {
        capturedSnapshot = input.snapshot;
        return Promise.resolve({
          usable: true,
          decision: { allowed: true },
          predictions: [],
          requestedPredictedBytes: 2n * GiB,
          reason: "test",
        });
      },
    );
    service = new CapacityPreflightService(
      { evaluateAdmission } as never,
      { current: () => ({ mode: "Hybrid" }) } as never,
    );

    await expect(
      service.admitRuntimeStart(tx, { appGroupId, singleAppId }),
    ).resolves.toMatchObject({ success: true });

    expect(capturedSnapshot).toMatchObject({
      appGroup: { runtimeState: "Running" },
      singleApps: [{
        id: singleAppId,
        runtimeState: "Running",
        desiredReplicas: 2,
      }],
    });
  });

  it("retains a committed runtime start in the Hybrid baseline until replicas are observed", async () => {
    const GiB = 1_073_741_824n;
    platform({ cpuNano: 20_000_000_000n, memoryBytes: 32n * GiB });
    const startedGroupId = "00000000-0000-0000-0000-000000000121";
    const startedAppId = "00000000-0000-0000-0000-000000000221";
    const deployed = {
      appGroupId: startedGroupId,
      version: 1,
      status: DeploymentStatus.Succeeded,
      phase: DeploymentPhase.Completed,
      stackConfig: JSON.stringify({
        appGroup: {
          id: startedGroupId,
          tenantId: "00000000-0000-0000-0000-000000000202",
          runtimeState: "Stopped",
        },
        singleApps: [{
          id: startedAppId,
          runtimeState: "Running",
          desiredReplicas: 1,
          resources: { cpu: "1", memoryBytes: String(GiB), gpu: 0 },
          volumes: [],
        }],
      }),
    };
    findDeployments
      .mockResolvedValueOnce([deployed])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([deployed]);
    findAppGroup.mockResolvedValue({ runtimeState: "Running" });
    findSingleApps
      .mockResolvedValueOnce([{
        id: startedAppId,
        runtimeState: "Running",
        desiredReplicas: 10,
        actualReplicas: 0,
      }])
      .mockResolvedValueOnce([{
        id: startedAppId,
        appGroupId: startedGroupId,
        runtimeState: "Running",
        pendingDeletion: false,
        appGroup: { runtimeState: "Running" },
        memoryBytes: 10n * GiB,
        desiredReplicas: 10,
        actualReplicas: 0,
      }]);

    const evaluateAdmission = vi.fn().mockResolvedValue({
      usable: true,
      decision: { allowed: true },
      predictions: [],
      requestedPredictedBytes: 0n,
      reason: "test",
    });
    service = new CapacityPreflightService(
      { evaluateAdmission } as never,
      { current: () => ({ mode: "Hybrid" }) } as never,
    );

    await expect(
      service.admitDeployment(
        tx,
        deploymentSnapshot({
          id: "00000000-0000-0000-0000-000000000122",
          cpu: "1",
          memoryBytes: String(GiB),
        }),
      ),
    ).resolves.toMatchObject({ success: true });

    expect(evaluateAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        runningApps: [expect.objectContaining({
          appId: startedAppId,
          hardLimitBytes: GiB,
          replicas: 1,
        })],
      }),
    );
  });

});
