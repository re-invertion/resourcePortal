import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const implementationUrl = new URL(
  "./deployment-operation-adapter.service.ts",
  import.meta.url,
);
const modulePath = "./deployment-operation-adapter.service";

type AdapterModule = {
  DeploymentOperationAdapterService: new (
    repository: unknown,
    prisma: unknown,
  ) => {
    mirrorCreatedDeployment: (
      tx: unknown,
      deployment: {
        id: string;
        appGroupId: string;
        version: number;
        phase: string;
        correlationId: string;
        rollbackTargetVersion: number | null;
      },
      tenantId: string,
      actor: { id: string; email: string; displayName: string },
    ) => Promise<unknown>;
    syncDeploymentOutcome: (deployment: {
      id: string;
      version: number;
      status: string;
      phase: string;
      rollbackTargetVersion: number | null;
      errorCode: string | null;
      errorMessage: string | null;
    }) => Promise<unknown>;
  };
  mapDeploymentOperationStatus: (
    deploymentStatus: string,
    operationType: "APP_GROUP_DEPLOY" | "APP_GROUP_ROLLBACK",
  ) => string;
};

async function loadAdapterModule() {
  const imported = (await import(modulePath)) as unknown;
  return imported as AdapterModule;
}

describe("Stage 16 DeploymentOperationAdapterService", () => {
  it("maps deployment terminal status into the common operation lifecycle", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { mapDeploymentOperationStatus } = await loadAdapterModule();

    expect(mapDeploymentOperationStatus("Succeeded", "APP_GROUP_DEPLOY")).toBe(
      "Succeeded",
    );
    expect(
      mapDeploymentOperationStatus("Succeeded", "APP_GROUP_ROLLBACK"),
    ).toBe("RolledBack");
    expect(mapDeploymentOperationStatus("Failed", "APP_GROUP_DEPLOY")).toBe(
      "Failed",
    );
    expect(mapDeploymentOperationStatus("RolledBack", "APP_GROUP_DEPLOY")).toBe(
      "RolledBack",
    );
    expect(
      mapDeploymentOperationStatus("RollbackFailed", "APP_GROUP_DEPLOY"),
    ).toBe("RollbackFailed");
  });

  it("mirrors a newly created deployment inside the caller transaction", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { DeploymentOperationAdapterService } = await loadAdapterModule();
    const queryRaw = vi.fn().mockResolvedValue([{ id: "operation-1" }]);
    const tx = { $queryRaw: queryRaw };
    const repository = {
      syncMirroredOperation: vi.fn(),
      appendEvent: vi.fn(),
    };
    const prisma = { $queryRaw: vi.fn() };
    const service = new DeploymentOperationAdapterService(repository, prisma);

    await service.mirrorCreatedDeployment(
      tx,
      {
        id: "11111111-1111-4111-8111-111111111111",
        appGroupId: "22222222-2222-4222-8222-222222222222",
        version: 7,
        phase: "Validating",
        correlationId: "corr-stage16",
        rollbackTargetVersion: null,
      },
      "33333333-3333-4333-8333-333333333333",
      {
        id: "44444444-4444-4444-8444-444444444444",
        email: "actor@example.com",
        displayName: "Actor",
      },
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0]?.[0] as { values?: unknown[] };
    expect(sql.values).toEqual(
      expect.arrayContaining([
        "APP_GROUP_DEPLOY",
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
        "actor@example.com",
      ]),
    );
  });

  it("synchronizes a successful rollback deployment as RolledBack", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { DeploymentOperationAdapterService } = await loadAdapterModule();
    const repository = {
      syncMirroredOperation: vi.fn().mockResolvedValue({
        id: "55555555-5555-4555-8555-555555555555",
        status: "RolledBack",
      }),
      appendEvent: vi.fn().mockResolvedValue(null),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: "55555555-5555-4555-8555-555555555555",
          type: "APP_GROUP_ROLLBACK",
        },
      ]),
    };
    const service = new DeploymentOperationAdapterService(repository, prisma);

    const result = await service.syncDeploymentOutcome({
      id: "11111111-1111-4111-8111-111111111111",
      version: 8,
      status: "Succeeded",
      phase: "Completed",
      rollbackTargetVersion: 7,
      errorCode: null,
      errorMessage: null,
    });

    expect(repository.syncMirroredOperation).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
      "RolledBack",
      "Completed",
      null,
      null,
      expect.objectContaining({
        deploymentId: "11111111-1111-4111-8111-111111111111",
        version: 8,
        rollbackTargetVersion: 7,
      }),
    );
    expect(repository.appendEvent).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
      expect.objectContaining({ event: "DeploymentOutcomeSynchronized" }),
    );
    expect(result).toEqual(expect.objectContaining({ status: "RolledBack" }));
  });
});
