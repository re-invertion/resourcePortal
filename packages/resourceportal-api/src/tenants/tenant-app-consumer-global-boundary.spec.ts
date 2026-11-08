import { ForbiddenException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "appuser@example.test", displayName: "App User",
  status: UserStatus.Active,
};
const dto = {
  name: "personal", displayName: "Personal", contactEmail: "appuser@example.test",
};

describe("global App User zero-admin boundary", () => {
  it("denies global tenant creation even though the endpoint only requires login", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tenantAppConsumer: { findFirst: vi.fn().mockResolvedValue({ membershipId: "app-user-id" }) },
      tenant: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const svc = new TenantsService(prisma as never, {} as never);
    await expect(svc.createTenant(dto, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(tx.tenantAppConsumer.findFirst).toHaveBeenCalledWith({
      where: { membership: { userId: actor.id, status: "Active" } },
      select: { membershipId: true },
    });
  });

  it("allows the existing tenant creation path for accounts without App User status", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tenantAppConsumer: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { create: vi.fn().mockResolvedValue({ id: "new-tenant" }) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const svc = new TenantsService(prisma as never, {} as never);
    await expect(svc.createTenant(dto, actor)).resolves.toEqual({ id: "new-tenant" });
    expect(tx.tenant.create).toHaveBeenCalledOnce();
  });
});
