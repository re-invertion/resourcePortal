import { ConflictException, ForbiddenException } from "@nestjs/common";
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

function fixture(privileged: boolean) {
  const created = {
    id: "44444444-4444-4444-8444-444444444444",
    appGroupId,
    singleAppId,
    name: "dns-udp",
    containerPort: 53,
    publishedPort: 53,
    protocol: "udp",
    createdBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    updatedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = {
    internalPortExposure: {
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue(created),
      delete: vi.fn().mockResolvedValue(created),
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
      findFirst: vi.fn().mockResolvedValue({ networkPrivileged: privileged }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
    internalPortExposure: {
      findFirst: vi.fn().mockResolvedValue(created),
      findMany: vi.fn().mockResolvedValue([]),
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

describe("privileged App Group networking", () => {
  it("rejects internal port publishing for a standard App Group", async () => {
    const { service } = fixture(false);
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
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("keeps ResourcePortal and Swarm infrastructure ports reserved", async () => {
    const { service } = fixture(true);
    await expect(
      service.createInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        {
          name: "bad-web",
          containerPort: 8080,
          publishedPort: 80,
          protocol: "tcp",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      service.createInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        {
          name: "bad-vxlan",
          containerPort: 4789,
          publishedPort: 4789,
          protocol: "udp",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("creates UDP/53 for a privileged App Group and marks the deployment draft changed", async () => {
    const { service, tx } = fixture(true);
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
    ).resolves.toMatchObject({
      name: "dns-udp",
      containerPort: 53,
      publishedPort: 53,
      protocol: "udp",
    });
    const createArgs = tx.internalPortExposure.create.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(createArgs?.data?.appGroupId).toBe(appGroupId);
    expect(createArgs?.data?.singleAppId).toBe(singleAppId);
    expect(createArgs?.data?.publishedPort).toBe(53);
    expect(createArgs?.data?.protocol).toBe("udp");

    const draftArgs = tx.appGroup.update.mock.calls[0]?.[0] as
      | { where?: { id?: string }; data?: Record<string, unknown> }
      | undefined;
    expect(draftArgs?.where?.id).toBe(appGroupId);
    expect(draftArgs?.data?.hasPendingChanges).toBe(true);
    expect(draftArgs?.data?.runtimeDraftRevision).toEqual({ increment: 1 });
  });

  it("does not reuse a host port while an older deployed artifact still owns it", async () => {
    const { service, prisma } = fixture(true);
    prisma.appGroup.findMany.mockResolvedValue([
      {
        id: appGroupId,
        name: "dns",
        currentDeploymentVersion: 3,
      },
    ]);
    prisma.appGroupDeployment.findFirst.mockResolvedValue({
      stackConfig: JSON.stringify({
        singleApps: [
          {
            internalPortExposures: [
              {
                id: "55555555-5555-4555-8555-555555555555",
                protocol: "udp",
                publishedPort: 53,
              },
            ],
          },
        ],
      }),
    });

    await expect(
      service.createInternalPortExposure(
        tenantId,
        appGroupId,
        singleAppId,
        {
          name: "replacement-dns",
          containerPort: 53,
          publishedPort: 53,
          protocol: "udp",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

});
