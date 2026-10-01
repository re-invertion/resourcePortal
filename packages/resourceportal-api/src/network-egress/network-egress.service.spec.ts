import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/types";
import { NetworkEgressService } from "./network-egress.service";
import {
  DEFAULT_BLOCKED_IPV4_CIDRS,
  DEFAULT_BLOCKED_IPV6_CIDRS,
  PLATFORM_EGRESS_POLICY_ID,
} from "./network-egress.constants";

const actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const satisfies AuthenticatedUser;

function fixture() {
  const tx = {
    platformEgressPolicy: {
      upsert: vi.fn().mockResolvedValue({
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: true,
        revision: 4,
        updatedAt: new Date("2026-09-25T12:00:00.000Z"),
      }),
    },
    auditLogEntry: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const transaction = vi
    .fn()
    .mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
  const prisma = {
    platformEgressPolicy: {
      upsert: vi.fn().mockResolvedValue({
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: true,
        revision: 3,
        updatedAt: new Date("2026-09-25T12:00:00.000Z"),
      }),
      update: vi.fn(),
    },
    workerReconciliationState: {
      findFirst: vi.fn().mockResolvedValue({
        lastSuccessAt: new Date("2026-09-25T12:01:00.000Z"),
        lastFailureAt: null,
        lastCompletedAt: new Date("2026-09-25T12:01:00.000Z"),
        lastResult: { revision: 3, enabled: true },
        lastError: null,
      }),
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  return { service: new NetworkEgressService(prisma), prisma, transaction, tx };
}

describe("NetworkEgressService", () => {
  it("rejects attempts to disable mandatory private-network isolation", async () => {
    const { service, transaction } = fixture();

    await expect(service.updatePolicy({ enabled: false }, actor)).rejects.toThrow(
      "mandatory and cannot be disabled",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keeps the compatibility PATCH endpoint for explicitly enabling/reapplying protection", async () => {
    const { service, tx } = fixture();

    const result = await service.updatePolicy({ enabled: true }, actor);

    expect(tx.platformEgressPolicy.upsert).toHaveBeenCalledWith({
      where: { id: PLATFORM_EGRESS_POLICY_ID },
      create: {
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: true,
        updatedBy: actor.id,
      },
      update: {
        enabled: true,
        revision: { increment: 1 },
        updatedBy: actor.id,
      },
    });
    expect(result).toMatchObject({ enabled: true, revision: 4 });
    expect(tx.auditLogEntry.create).toHaveBeenCalled();
  });

  it("self-heals a legacy disabled policy before exposing a worker snapshot", async () => {
    const { service, prisma } = fixture();
    vi.mocked(prisma.platformEgressPolicy.upsert).mockResolvedValueOnce({
      id: PLATFORM_EGRESS_POLICY_ID,
      enabled: false,
      revision: 8,
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    vi.mocked(prisma.platformEgressPolicy.update).mockResolvedValueOnce({
      id: PLATFORM_EGRESS_POLICY_ID,
      enabled: true,
      revision: 9,
      updatedAt: new Date("2026-10-01T00:00:01.000Z"),
      updatedBy: null,
    });

    await expect(service.policySnapshot()).resolves.toMatchObject({
      enabled: true,
      revision: 9,
    });
    expect(prisma.platformEgressPolicy.update).toHaveBeenCalledWith({
      where: { id: PLATFORM_EGRESS_POLICY_ID },
      data: {
        enabled: true,
        revision: { increment: 1 },
      },
    });
  });

  it("produces a version 2 fail-closed worker snapshot without per-App-Group exceptions", async () => {
    const { service } = fixture();

    const snapshot = await service.policySnapshot();

    expect(snapshot).toEqual({
      version: 2,
      enabled: true,
      revision: 3,
      blockedIpv4Cidrs: DEFAULT_BLOCKED_IPV4_CIDRS,
      blockedIpv6Cidrs: DEFAULT_BLOCKED_IPV6_CIDRS,
    });
    expect(snapshot).not.toHaveProperty("rules");
    expect(snapshot).not.toHaveProperty("privilegedAppGroupIds");
  });

  it("returns only global policy and enforcement state to Platform Admin", async () => {
    const { service } = fixture();

    const state = await service.getPlatformState();

    expect(state.enabled).toBe(true);
    expect(state.revision).toBe(3);
    expect(state.protectedCidrs).toEqual([
      ...DEFAULT_BLOCKED_IPV4_CIDRS,
      ...DEFAULT_BLOCKED_IPV6_CIDRS,
    ]);
    expect(state.enforcement).toMatchObject({
      lastResult: { revision: 3, enabled: true },
    });
    expect(state).not.toHaveProperty("appGroups");
    expect(state).not.toHaveProperty("rules");
  });
});
