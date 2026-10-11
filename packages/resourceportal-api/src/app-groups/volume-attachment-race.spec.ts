import { describe, expect, it, vi } from "vitest";
import { AppGroupsService } from "./app-groups.service";

describe("volume attach cannot race ahead of a delete (#254)", () => {
  it("rechecks readiness under the same tenant lock as physical deletion", async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      volume: { findFirst: vi.fn().mockResolvedValue({ status: "Deleting" }) },
      volumeAttachment: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction)),
    };
    const volumesService = { assertVolumeBelongsToTenant: vi.fn().mockResolvedValue(undefined) };
    const service = Object.assign(Object.create(AppGroupsService.prototype), {
      prisma,
      volumesService,
      ensureSingleAppBelongsToAppGroup: vi.fn().mockResolvedValue({ pendingDeletion: false }),
    }) as { attachVolume: (tenant: string, group: string, app: string, dto: object, actor: object) => Promise<unknown> };
    await expect(service.attachVolume(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      { volumeId: "44444444-4444-4444-8444-444444444444", mountPath: "/data", mode: "ReadWrite" },
      { id: "55555555-5555-4555-8555-555555555555" },
    )).rejects.toThrow("VolumeNotReadyForAttachment");
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.volume.findFirst).toHaveBeenCalledOnce();
    expect(transaction.volumeAttachment.create).not.toHaveBeenCalled();
  });
});
