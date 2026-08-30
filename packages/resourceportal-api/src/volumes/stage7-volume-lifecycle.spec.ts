import { ConfigService } from "@nestjs/config";
import { VolumeStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
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
      "/rp/volumes/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222",
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
  const config = {
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  };
  const storage = {
    measureUsedSize: vi.fn(() => Promise.resolve(0n)),
    deleteVolumeData: vi.fn(() => Promise.resolve()),
  };
  const service = Reflect.construct(VolumesService, [
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    storage,
  ]) as VolumesService;

  return { prisma, storage, service };
}

describe("Stage 7 volume lifecycle", () => {
  it("refreshes usedSizeBytes from physical storage when a volume is read", async () => {
    const item = volume();
    const { prisma, storage, service } = serviceFor(item);
    storage.measureUsedSize.mockResolvedValue(4096n);

    const result = await service.getVolume(item.tenantId, item.id);

    expect(storage.measureUsedSize).toHaveBeenCalledWith(item.storagePath);
    expect(prisma.volume.update).toHaveBeenCalledWith({
      where: { id: item.id },
      data: { usedSizeBytes: 4096n },
      include: { attachments: true },
    });
    expect(result.usedSizeBytes).toBe("4096");
  });

  it("removes Docker and filesystem data before deleting the database record", async () => {
    const item = volume();
    const { prisma, storage, service } = serviceFor(item);

    await service.deleteVolume(item.tenantId, item.id, actor);

    expect(storage.deleteVolumeData).toHaveBeenCalledWith({
      tenantId: item.tenantId,
      volumeId: item.id,
      storagePath: item.storagePath,
      dockerVolumeName: item.dockerVolumeName,
    });
    expect(prisma.volume.delete).toHaveBeenCalledWith({
      where: { id: item.id },
    });
    expect(storage.deleteVolumeData.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.volume.delete.mock.invocationCallOrder[0],
    );
  });

  it("keeps the database record and marks the volume Error when physical cleanup fails", async () => {
    const item = volume();
    const { prisma, storage, service } = serviceFor(item);
    storage.deleteVolumeData.mockRejectedValue(new Error("docker unavailable"));

    await expect(
      service.deleteVolume(item.tenantId, item.id, actor),
    ).rejects.toThrow("docker unavailable");

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
    const { prisma, storage, service } = serviceFor(item);

    await expect(
      service.deleteVolume(item.tenantId, item.id, actor),
    ).rejects.toThrow("VolumeInUse");

    expect(storage.deleteVolumeData).not.toHaveBeenCalled();
    expect(prisma.volume.delete).not.toHaveBeenCalled();
  });
});
