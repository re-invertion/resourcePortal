import { describe, expect, it, vi } from "vitest";
import { VolumeUsageReconcilerService } from "./volume-usage-reconciler.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageBackendsService } from "../storage-backends/storage-backends.service";

describe("Volume usage cursor sweep (#270)", () => {
  it("eventually measures a newer volume beyond a full stable batch, including an old failing volume", async () => {
    const volumes = [
      { id: "a", storagePath: "/vol/a", usedSizeBytes: 0n },
      { id: "b", storagePath: "/vol/b", usedSizeBytes: 0n },
      { id: "c", storagePath: "/vol/c", usedSizeBytes: 0n },
    ];
    const findMany = vi.fn(({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
      Promise.resolve(volumes.filter((v) => !where.id || v.id > where.id.gt).slice(0, take)),
    );
    const update = vi.fn().mockResolvedValue({});
    const measureUsedSize = vi.fn((id: string) => {
      if (id === "a") return Promise.reject(new Error("mount is busy"));
      return Promise.resolve(id === "c" ? 10n : 0n);
    });
    const service = new VolumeUsageReconcilerService(
      { volume: { findMany, update } } as unknown as PrismaService,
      { measureUsedSize } as unknown as StorageBackendsService,
    );
    expect(await service.reconcileBatch(2)).toEqual({ scanned: 2, updated: 0, failed: 1 });
    expect(await service.reconcileBatch(2)).toEqual({ scanned: 1, updated: 1, failed: 0 });
    expect(update).toHaveBeenCalledWith({ where: { id: "c" }, data: { usedSizeBytes: 10n } });
    expect(await service.reconcileBatch(2)).toEqual({ scanned: 2, updated: 0, failed: 1 });
    expect(measureUsedSize.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "a", "b"]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "Ready", id: { gt: "b" } }, orderBy: { id: "asc" },
    }));
  });
});
