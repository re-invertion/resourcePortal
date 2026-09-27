import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

describe("TenantsService.getTenant", () => {
  it("returns a JSON-serializable tenant when quota contains bigint values", async () => {
    const tenant = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "codespace-demo",
      displayName: "Codespaces Demo",
      description: null,
      status: "Active",
      contactEmail: "codespace-admin@resourceportal.local",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      billing: null,
      authPolicy: null,
      memberships: [],
      quota: {
        id: "22222222-2222-4222-8222-222222222222",
        tenantId: "11111111-1111-4111-8111-111111111111",
        cpu: new Prisma.Decimal("4"),
        memoryBytes: 4294967296n,
        gpu: 0,
        storageBytes: 10737418240n,
        maxSingleApps: 20,
        maxVolumes: 10,
        createdBy: "33333333-3333-4333-8333-333333333333",
        updatedBy: "33333333-3333-4333-8333-333333333333",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    };

    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue(tenant),
      },
    };
    const service = new TenantsService(prisma as never, { sendTenantInvitation: vi.fn() } as never);

    const result = await service.getTenant(tenant.id);

    expect(result.quota?.memoryBytes).toBe("4294967296");
    expect(result.quota?.storageBytes).toBe("10737418240");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});


describe("TenantsService invitation email delivery", () => {
  it("attempts SMTP delivery after the invitation transaction and returns delivery status with the fallback token", async () => {
    const expiresAt = new Date("2026-09-28T16:00:00.000Z");
    const created = {
      id: "44444444-4444-4444-8444-444444444444",
      tenantId: "11111111-1111-4111-8111-111111111111",
      email: "alice@example.com",
      tokenHash: "hash",
      roleIds: ["tenant-viewer"],
      expiresAt,
      lastSentAt: new Date(),
      createdBy: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date(),
    };
    const tx = {
      tenantInvitation: {
        create: vi.fn().mockResolvedValue(created),
      },
      auditLogEntry: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: created.tenantId,
          name: "Acme",
        }),
      },
      role: {
        findMany: vi.fn().mockResolvedValue([{ id: "tenant-viewer" }]),
      },
      tenantMembership: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => Promise.resolve(callback(tx))),
    };
    const email = {
      sendTenantInvitation: vi.fn().mockResolvedValue({
        attempted: true,
        sent: true,
      }),
    };
    const service = new TenantsService(prisma as never, email as never);

    const result = await service.createInvitation(
      created.tenantId,
      { email: created.email, roleIds: created.roleIds },
      {
        id: created.createdBy,
        email: "admin@example.com",
        displayName: "Admin",
      } as never,
    );

    expect(email.sendTenantInvitation).toHaveBeenCalledTimes(1);
    const deliveryCall = email.sendTenantInvitation.mock.calls[0]?.[0] as {
      recipient?: string;
      tenantName?: string;
      token?: string;
      expiresAt?: Date;
    };
    expect(deliveryCall.recipient).toBe(created.email);
    expect(deliveryCall.tenantName).toBe("Acme");
    expect(typeof deliveryCall.token).toBe("string");
    expect(deliveryCall.expiresAt).toEqual(expiresAt);
    expect(result.emailDelivery).toEqual({ attempted: true, sent: true });
    expect(typeof result.token).toBe("string");
  });
});
