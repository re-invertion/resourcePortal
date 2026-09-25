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
        enabled: false,
        revision: 2,
        updatedAt: new Date("2026-09-25T12:00:00.000Z"),
      }),
    },
    auditLogEntry: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    platformEgressPolicy: {
      upsert: vi.fn().mockResolvedValue({
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: true,
        revision: 3,
        updatedAt: new Date("2026-09-25T12:00:00.000Z"),
      }),
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
    $transaction: vi
      .fn()
      .mockImplementation(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
  } as unknown as PrismaService;

  return { service: new NetworkEgressService(prisma), prisma, tx };
}

describe("NetworkEgressService", () => {
  it("increments the desired revision when Platform Admin changes enforcement", async () => {
    const { service, tx } = fixture();

    const result = await service.updatePolicy({ enabled: false }, actor);

    expect(tx.platformEgressPolicy.upsert).toHaveBeenCalledWith({
      where: { id: PLATFORM_EGRESS_POLICY_ID },
      create: {
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: false,
        updatedBy: actor.id,
      },
      update: {
        enabled: false,
        revision: { increment: 1 },
        updatedBy: actor.id,
      },
    });
    expect(result).toMatchObject({ enabled: false, revision: 2 });
    expect(tx.auditLogEntry.create).toHaveBeenCalled();
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
