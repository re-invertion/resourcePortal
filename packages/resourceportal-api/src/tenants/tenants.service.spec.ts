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
    const service = new TenantsService(prisma as never);

    const result = await service.getTenant(tenant.id);

    expect(result.quota?.memoryBytes).toBe("4294967296");
    expect(result.quota?.storageBytes).toBe("10737418240");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
