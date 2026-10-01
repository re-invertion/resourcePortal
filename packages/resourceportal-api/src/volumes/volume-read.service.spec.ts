import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { VolumeReadService } from "./volume-read.service";

function volume(attachments: Array<{ id: string }> = []) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    name: "data",
    description: null,
    status: "Ready",
    sizeBytes: 1024n,
    usedSizeBytes: 256n,
    pendingSizeBytes: null,
    storagePath: "/srv/resource-portal/storage/volumes/data",
    dockerVolumeName: "rp_vol_data",
    storageBackendId: "33333333-3333-4333-8333-333333333333",
    storageProjectId: 10001,
    createdBy: "44444444-4444-4444-8444-444444444444",
    updatedBy: "44444444-4444-4444-8444-444444444444",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    attachments,
  };
}

describe("VolumeReadService", () => {
  it("loads attachments when listing volumes and exposes the attached-app count", async () => {
    const findMany = vi.fn().mockResolvedValue(
      [volume([{ id: "a1" }, { id: "a2" }])],
    );
    const prisma = { volume: { findMany } };
    const service = new VolumeReadService(prisma as unknown as PrismaService);

    await expect(
      service.listVolumes("22222222-2222-4222-8222-222222222222"),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "data",
        attachmentCount: 2,
        sizeBytes: "1024",
        usedSizeBytes: "256",
      }),
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "22222222-2222-4222-8222-222222222222" },
      include: { attachments: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("loads attachments for a single volume read", async () => {
    const findFirst = vi.fn().mockResolvedValue(volume([{ id: "a1" }]));
    const prisma = { volume: { findFirst } };
    const service = new VolumeReadService(prisma as unknown as PrismaService);

    await expect(
      service.getVolume(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual(expect.objectContaining({ attachmentCount: 1 }));

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "11111111-1111-4111-8111-111111111111",
        tenantId: "22222222-2222-4222-8222-222222222222",
      },
      include: { attachments: true },
    });
  });
});
