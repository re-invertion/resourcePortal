import { VolumeStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { StorageBackendsService } from "../storage-backends/storage-backends.service";
import { VolumesService } from "./volumes.service";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const;

const tenantId = "33333333-3333-4333-8333-333333333333";
const backend = {
  id: "00000000-0000-4000-8000-000000000014",
  name: "default-local-filesystem",
  type: "LocalFilesystem" as const,
  basePath: "/srv/resource-portal/storage",
  volumeBasePath: "/srv/resource-portal/storage/volumes",
  secretBasePath: "/srv/resource-portal/storage/secrets",
  status: "Ready" as const,
  health: "Healthy" as const,
  maintenance: false,
  capacityTotal: 10_000n,
  capacityAvailable: 10_000n,
  lastValidatedAt: new Date(),
  lastValidationError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createHarness() {
  let insideTransaction = false;
  let createdVolume: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
    quota: { findUnique: vi.fn(() => Promise.resolve(null)) },
    volume: {
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        createdVolume = {
          ...data,
          usedSizeBytes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          attachments: [],
        };
        return Promise.resolve(createdVolume);
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => {
      insideTransaction = true;
      try {
        return await callback(tx);
      } finally {
        insideTransaction = false;
      }
    }),
    volume: {
      update: vi.fn(() =>
        Promise.resolve({
          ...createdVolume,
          status: VolumeStatus.Ready,
          attachments: [],
        }),
      ),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const storageBackends = {
    refreshDefaultBackendForWrite: vi.fn(() => Promise.resolve(backend)),
    reserveVolume: vi.fn((_tx: unknown, input: { tenantId: string; volumeId: string }) =>
      Promise.resolve({
        backend,
        storagePath: `/srv/resource-portal/storage/volumes/${input.tenantId}/${input.volumeId}`,
        projectId: 12001,
      }),
    ),
    provisionVolume: vi.fn(() => {
      expect(insideTransaction).toBe(false);
      return Promise.resolve();
    }),
    cleanupProvisionedVolume: vi.fn(() => Promise.resolve()),
  };
  const service = new VolumesService(
    prisma as unknown as PrismaService,
    storageBackends as unknown as StorageBackendsService,
  );

  return { service, storageBackends, tx };
}

describe("Stage 14 Volume backend transaction boundaries", () => {
  it("persists the allocated project id before physical provisioning", async () => {
    const { service, storageBackends, tx } = createHarness();

    await service.createVolume(
      tenantId,
      { name: "data", description: undefined, sizeBytes: 4096 },
      actor,
    );

    expect(storageBackends.reserveVolume).toHaveBeenCalledTimes(1);
    const createInput = tx.volume.create.mock.calls[0]?.[0];
    expect(createInput?.data.storageProjectId).toBe(12001);
    expect(storageBackends.provisionVolume).toHaveBeenCalledTimes(1);
  });
});
