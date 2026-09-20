import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import type { PrismaService } from "../prisma/prisma.service";
import { NetworkEgressService } from "./network-egress.service";
import { PLATFORM_EGRESS_POLICY_ID } from "./network-egress.constants";

const actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as AuthenticatedUser;

function fixture() {
  let policy = {
    id: PLATFORM_EGRESS_POLICY_ID,
    enabled: true,
    revision: 1,
    updatedBy: null as string | null,
    createdAt: new Date("2026-09-20T16:00:00Z"),
    updatedAt: new Date("2026-09-20T16:00:00Z"),
  };
  const rules: Array<{
    id: string;
    appGroupId: string;
    destinationCidr: string;
    protocol: string;
    port: number;
    description: string | null;
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const policyUpsert = vi.fn(
    ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      if (update.revision && typeof update.revision === "object") {
        policy = {
          ...policy,
          enabled:
            typeof update.enabled === "boolean" ? update.enabled : policy.enabled,
          revision: policy.revision + 1,
          updatedBy:
            typeof update.updatedBy === "string" ? update.updatedBy : policy.updatedBy,
          updatedAt: new Date(),
        };
      } else if (typeof update.enabled === "boolean") {
        policy = { ...policy, enabled: update.enabled, updatedAt: new Date() };
      } else if (policy.id !== PLATFORM_EGRESS_POLICY_ID) {
        policy = create as typeof policy;
      }
      return Promise.resolve(policy);
    },
  );
  const ruleCreate = vi.fn(({ data }: { data: Record<string, unknown> }) => {
    const rule = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      appGroupId: String(data.appGroupId),
      destinationCidr: String(data.destinationCidr),
      protocol: String(data.protocol),
      port: Number(data.port),
      description:
        typeof data.description === "string" ? data.description : null,
      createdBy: String(data.createdBy),
      updatedBy: String(data.updatedBy),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    rules.push(rule);
    return Promise.resolve(rule);
  });
  const tx = {
    platformEgressPolicy: { upsert: policyUpsert },
    platformEgressAllowRule: {
      create: ruleCreate,
      delete: vi.fn().mockResolvedValue({}),
    },
    auditLogEntry: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    platformEgressPolicy: {
      upsert: vi.fn(() => Promise.resolve(policy)),
    },
    platformEgressAllowRule: {
      findMany: vi.fn(() => Promise.resolve([...rules])),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    appGroup: {
      findUnique: vi.fn().mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        name: "penpot",
        tenant: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Design",
        },
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workerReconciliationState: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  return {
    prisma,
    tx,
    service: new NetworkEgressService(prisma as unknown as PrismaService),
  };
}

describe("NetworkEgressService", () => {
  it("increments the desired revision when Platform Admin changes enforcement", async () => {
    const { service, tx } = fixture();
    await expect(service.updatePolicy({ enabled: false }, actor)).resolves.toMatchObject({
      enabled: false,
      revision: 2,
    });
    const auditArgs = tx.auditLogEntry.create.mock.calls[0]?.[0];
    expect(auditArgs?.data.action).toBe("platform_network_egress.update");
  });

  it("normalizes an App Group exception and increments policy revision", async () => {
    const { service, tx } = fixture();
    const rule = await service.createRule(
      {
        appGroupId: "11111111-1111-4111-8111-111111111111",
        destinationCidr: "192.168.100.55/24",
        protocol: "tcp",
        port: 443,
        description: "  monitoring  ",
      },
      actor,
    );

    expect(rule).toMatchObject({
      destinationCidr: "192.168.100.0/24",
      protocol: "tcp",
      port: 443,
      description: "monitoring",
    });
    const policyArgs = tx.platformEgressPolicy.upsert.mock.calls.at(-1)?.[0];
    expect(policyArgs?.update.revision).toEqual({ increment: 1 });
  });

  it("rejects a port when protocol is any", async () => {
    const { service } = fixture();
    await expect(
      service.createRule(
        {
          appGroupId: "11111111-1111-4111-8111-111111111111",
          destinationCidr: "192.168.100.50/32",
          protocol: "any",
          port: 443,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("produces a stable worker snapshot with private ranges and normalized rules", async () => {
    const { service, prisma } = fixture();
    prisma.platformEgressAllowRule.findMany.mockResolvedValue([
      {
        id: "rule-1",
        appGroupId: "11111111-1111-4111-8111-111111111111",
        destinationCidr: "192.168.100.50/32",
        protocol: "tcp",
        port: 443,
        description: null,
        createdBy: actor.id,
        updatedBy: actor.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const snapshot = await service.policySnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.blockedIpv4Cidrs).toContain("10.0.0.0/8");
    expect(snapshot.blockedIpv4Cidrs).toContain("192.168.0.0/16");
    expect(
      snapshot.rules.map((rule) => ({
        id: rule.id,
        appGroupId: rule.appGroupId,
        destinationCidr: rule.destinationCidr,
        protocol: rule.protocol,
        port: rule.port,
      })),
    ).toEqual([
      {
        id: "rule-1",
        appGroupId: "11111111-1111-4111-8111-111111111111",
        destinationCidr: "192.168.100.50/32",
        protocol: "tcp",
        port: 443,
      },
    ]);
  });
});
