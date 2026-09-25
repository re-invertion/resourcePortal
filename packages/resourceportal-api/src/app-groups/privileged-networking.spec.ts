/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { AppGroupsService } from "./app-groups.service";

const actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as never;
const tenantId = "11111111-1111-4111-8111-111111111111";
const appGroupId = "22222222-2222-4222-8222-222222222222";
const singleAppId = "33333333-3333-4333-8333-333333333333";
const exposureId = "44444444-4444-4444-8444-444444444444";

function fixture() {
  const exposure = {
    id: exposureId,
    appGroupId,
    singleAppId,
    name: "dns-udp",
    containerPort: 53,
    publishedPort: 53,
    protocol: "udp",
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = {
    internalPortExposure: {
      delete: vi.fn().mockResolvedValue(exposure),
    },
    appGroup: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    singleApp: {
      findFirst: vi.fn().mockResolvedValue({
        id: singleAppId,
        appGroupId,
        pendingDeletion: false,
      }),
    },
    appGroup: {
      findFirst: vi.fn().mockResolvedValue({ id: appGroupId, tenantId }),
    },
    internalPortExposure: {
      findFirst: vi.fn().mockResolvedValue(exposure),
      findMany: vi.fn().mockResolvedValue([
        {
          ...exposure,
          singleApp: { id: singleAppId, name: "dns" },
        },
      ]),
    },
    $transaction: vi.fn(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const service = new AppGroupsService(
    prisma as unknown as PrismaService,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, prisma, tx };
}

describe("legacy privileged App Group networking migration", () => {
  it("rejects creation of new Internal Port Exposures", async () => {
    const { service } = fixture();
    await expect(
      service.createInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        {
          name: "dns-udp",
          containerPort: 53,
          publishedPort: 53,
          protocol: "udp",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      message: expect.stringMatching(/deprecated.*read-only/i),
    });
  });

  it("rejects edits to an existing legacy Internal Port Exposure", async () => {
    const { service } = fixture();
    await expect(
      service.updateInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        exposureId,
        { publishedPort: 5353 },
        actor,
      ),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      message: expect.stringMatching(/deprecated.*read-only/i),
    });
  });

  it("keeps list/delete available so legacy exposures can be drained safely", async () => {
    const { service, tx } = fixture();

    await expect(
      service.listInternalPortExposures(tenantId, appGroupId),
    ).resolves.toEqual([
      expect.objectContaining({
        id: exposureId,
        singleAppName: "dns",
      }),
    ]);

    await expect(
      service.deleteInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        exposureId,
        actor,
      ),
    ).resolves.toEqual({ deleted: true });

    expect(tx.internalPortExposure.delete).toHaveBeenCalledWith({
      where: { id: exposureId },
    });
    expect(tx.appGroup.update).toHaveBeenCalledWith({
      where: { id: appGroupId },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: { increment: 1 },
        updatedBy: actor.id,
      },
    });
  });
});