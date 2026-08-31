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

function createHarness() {
  let insideTransaction = false;
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
    quota: { findUnique: vi.fn(() => Promise.resolve(null)) },
    volume: {
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...data,
          usedSizeBytes: null,
          status: VolumeStatus.Ready,
          createdAt: new Date(),
          updatedAt: new Date(),
          attachments: [],
        }),
      ),
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
  };
  const storageBackends = {
    provisionVolume: vi.fn(() => {
      expect(insideTransaction).toBe(false);
      return Promise.resolve({
        backendId: "00000000-0000-4000-8000-000000000014",
        storagePath: "/rp/volumes/tenant/volume",
      });
    }),
    cleanupProvisionedVolume: vi.fn(() => Promise.resolve()),
  };
  const service = new VolumesService(
    prisma as unknown as PrismaService,
    storageBackends as unknown as StorageBackendsService,
  );

  return { service, storageBackends };
}

describe("Stage 14 Volume backend transaction boundaries", () => {
  it("does not perform physical StorageBackend provisioning inside the quota transaction", async () => {
    const { service, storageBackends } = createHarness();

    await service.createVolume(
      tenantId,
      { name: "data", description: undefined, sizeBytes: 4096 },
      actor,
    );

    expect(storageBackends.provisionVolume).toHaveBeenCalledTimes(1);
  });
});
