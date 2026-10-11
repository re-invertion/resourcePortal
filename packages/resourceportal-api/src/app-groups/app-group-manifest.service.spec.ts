import { describe, expect, it, vi } from "vitest";
import { AppGroupManifestService } from "./app-group-manifest.service";

const source = `
apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: demo
spec:
  runtimeState: Stopped
`;

function fixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    quota: { findUnique: vi.fn().mockResolvedValue(null) },
    singleApp: { findMany: vi.fn().mockResolvedValue([]) },
    appGroup: {
      create: vi.fn().mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        name: "demo",
        hasPendingChanges: false,
      }),
    },
    tenant: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "tenant" }),
    },
    auditLogEntry: {
      create: vi.fn<(input: { data: { action: string; resourceName?: string | null; [key: string]: unknown } }) => Promise<Record<string, never>>>().mockResolvedValue({}),
    },
  };

  const prisma = {
    appGroup: { findFirst: vi.fn().mockResolvedValue(null) },
    registry: { findMany: vi.fn().mockResolvedValue([]) },
    volume: { findMany: vi.fn().mockResolvedValue([]) },
    domain: { findMany: vi.fn().mockResolvedValue([]) },
    quota: { findUnique: vi.fn().mockResolvedValue(null) },
    singleApp: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => Promise.resolve(callback(tx))),
  };
  const registries = {
    assertRegistryCanBeUsedByImage: vi.fn(),
  };
  const secretStorage = {
    seal: vi.fn((value: Buffer) => `sealed:${value.toString("base64")}`),
  };

  const service = new AppGroupManifestService(
    prisma as never,
    registries as never,
    secretStorage as never,
  );

  return { service, prisma, tx };
}

describe("AppGroupManifestService", () => {
  it("validates without starting a write transaction", async () => {
    const { service, prisma } = fixture();

    const result = await service.validateManifest(
      "22222222-2222-4222-8222-222222222222",
      source,
      ["appgroup.create"],
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      appGroupName: "demo",
      apps: 0,
      requiredPermissions: ["appgroup.create"],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("revalidates and applies a valid manifest inside one transaction", async () => {
    const { service, prisma, tx } = fixture();

    const result = await service.applyManifest(
      "22222222-2222-4222-8222-222222222222",
      source,
      ["appgroup.create"],
      {
        id: "33333333-3333-4333-8333-333333333333",
        email: "user@example.com",
        displayName: "Example User",
        status: "Active",
      },
    );

    expect(prisma.appGroup.findFirst).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.appGroup.create).toHaveBeenCalledTimes(1);
    const auditInput = tx.auditLogEntry.create.mock.calls[0]?.[0];
    expect(auditInput?.data.action).toBe("appgroup.import");
    expect(auditInput?.data.resourceName).toBe("demo");
    expect(result).toMatchObject({
      name: "demo",
      imported: true,
      hasPendingChanges: false,
    });
  });
});


describe("AppGroupManifestService quota concurrency (#253)", () => {
  it("rechecks the quota while holding the tenant lock before any import write", async () => {
    const { service, prisma, tx } = fixture();
    // Preflight observes no quota. A concurrent operation persists a workload
    // before the import transaction acquires the shared advisory lock.
    tx.quota.findUnique.mockResolvedValue({
      cpu: 1, memoryBytes: 1342177280n, gpu: 0, maxSingleApps: 1,
    });
    tx.singleApp.findMany.mockResolvedValue([{
      cpu: 1, memoryBytes: 134217728n, gpu: 0, desiredReplicas: 1,
    }]);
    const manifest = `
apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: demo
spec:
  apps:
    - name: web
      image: nginx:latest
      resources:
        cpu: 0.5
        memoryBytes: 134217728
`;
    await expect(service.applyManifest(
      "22222222-2222-4222-8222-222222222222", manifest,
      ["appgroup.create", "singleapp.create"],
      { id: "33333333-3333-4333-8333-333333333333", email: "user@example.com", displayName: "Example User", status: "Active" },
    )).rejects.toThrow("App Group manifest quota changed before import");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.quota.findUnique).toHaveBeenCalledOnce();
    expect(tx.appGroup.create).not.toHaveBeenCalled();
  });
});
