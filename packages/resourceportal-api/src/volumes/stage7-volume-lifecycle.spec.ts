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

function volume(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    name: "data",
    description: null,
    storagePath:
      "/srv/resource-portal/storage/volumes/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222",
    dockerVolumeName:
      "rp_vol_22222222_2222_4222_8222_222222222222",
    sizeBytes: 10_000n,
    usedSizeBytes: null,
    status: VolumeStatus.Ready,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    attachments: [],
    ...overrides,
  };
}

function serviceFor(item = volume()) {
  let current = { ...item };
  const prisma = {
    volume: {
      findFirst: vi.fn(() => Promise.resolve(current)),
      findMany: vi.fn(() => Promise.resolve([current])),
      update: vi.fn((params: { data: Record<string, unknown> }) => {
        current = { ...current, ...params.data };
        return Promise.resolve(current);
      }),
      delete: vi.fn(() => Promise.resolve(current)),
    },
    quota: {
      findUnique: vi.fn(() => Promise.resolve(null)),
    },
  };
  const storageBackends = {
    measureUsedSize: vi.fn(() => Promise.resolve(0n)),
    deleteVolume: vi.fn(() => Promise.resolve()),
  };
  const service = Reflect.construct(VolumesService, [
    prisma as unknown as PrismaService,
    storageBackends as unknown as StorageBackendsService,
  ]);

  return { prisma, storageBackends, service };
}

describe("Stage 7 volume lifecycle through Stage 14 backend", () => {
  it("refreshes usedSizeBytes from physical storage when a volume is read", async () => {
    const item = volume();
    const { prisma, storageBackends, service } = serviceFor(item);
    storageBackends.measureUsedSize.mockResolvedValue(4096n);

    const result = await service.getVolume(item.tenantId, item.id);

    expect(storageBackends.measureUsedSize).toHaveBeenCalledWith(
      item.id,
      item.storagePath,
    );
    expect(prisma.volume.update).toHaveBeenCalledWith({
      where: { id: item.id },
      data: { usedSizeBytes: 4096n },
      include: { attachments: true },
    });
    expect(result.usedSizeBytes).toBe("4096");
  });

  it("removes backend data before deleting the database record", async () => {
    const item = volume();
    const { prisma, storageBackends, service } = serviceFor(item);

    await service.deleteVolume(item.tenantId, item.id, actor);

    expect(storageBackends.deleteVolume).toHaveBeenCalledWith(
      item.id,
      item.storagePath,
    );
    expect(prisma.volume.delete).toHaveBeenCalledWith({
      where: { id: item.id },
    });
    expect(storageBackends.deleteVolume.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.volume.delete.mock.invocationCallOrder[0],
    );
  });

  it("keeps the database record and marks the volume Error when physical cleanup fails", async () => {
    const item = volume();
    const { prisma, storageBackends, service } = serviceFor(item);
    storageBackends.deleteVolume.mockRejectedValue(new Error("storage unavailable"));

    await expect(
      service.deleteVolume(item.tenantId, item.id, actor),
    ).rejects.toThrow("storage unavailable");

    expect(prisma.volume.delete).not.toHaveBeenCalled();
    expect(prisma.volume.update).toHaveBeenLastCalledWith({
      where: { id: item.id },
      data: {
        status: VolumeStatus.Error,
        updatedBy: actor.id,
      },
    });
  });

  it("does not touch physical storage while the volume has attachments", async () => {
    const item = volume({ attachments: [{ id: "attachment-1" }] });
    const { prisma, storageBackends, service } = serviceFor(item);

    await expect(
      service.deleteVolume(item.tenantId, item.id, actor),
    ).rejects.toThrow("VolumeInUse");

    expect(storageBackends.deleteVolume).not.toHaveBeenCalled();
    expect(prisma.volume.delete).not.toHaveBeenCalled();
  });
});
