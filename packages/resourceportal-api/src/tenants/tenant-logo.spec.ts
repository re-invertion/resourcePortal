import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { validatedTenantLogo } from "./tenant-logo";
import { TenantsService } from "./tenants.service";

const tinyPng = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64")}`;

describe("Tenant branding validation", () => {
  it("allows only small raster signatures, not executable images or mismatched declarations", () => {
    expect(validatedTenantLogo(tinyPng)).toBe(tinyPng);
    expect(validatedTenantLogo(null)).toBeNull();
    expect(() => validatedTenantLogo("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(BadRequestException);
    expect(() => validatedTenantLogo("data:image/jpeg;base64," + tinyPng.split(",")[1])).toThrow(BadRequestException);
    expect(() => validatedTenantLogo("data:image/png;base64,%%%")).toThrow(BadRequestException);
    expect(() => validatedTenantLogo("data:image/png;base64," + Buffer.alloc(128 * 1024 + 1).toString("base64"))).toThrow(BadRequestException);
  });

  it("updates only tenant branding, and records an audit event without embedding the logo data", async () => {
    const tenant = { id: "tenant-1", name: "tenant", displayName: "Old" };
    const update = vi.fn().mockResolvedValue({ ...tenant, displayName: "New", logoDataUrl: tinyPng });
    const create = vi.fn().mockResolvedValue({});
    const tx = { tenant: { update }, auditLogEntry: { create } };
    const prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue(tenant) },
      $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new TenantsService(prisma as never, {} as never);
    const result = await service.updateBranding(tenant.id, { displayName: " New ", logoDataUrl: tinyPng }, {
      id: "user-1", displayName: "Administrator",
    } as never);
    expect(result.displayName).toBe("New");
    expect(update).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { displayName: "New", logoDataUrl: tinyPng } });
    const audit = (create.mock.calls[0]?.[0] as { data: { action: string; changes: unknown } }).data;
    expect(audit.action).toBe("tenant.branding.update");
    expect(JSON.stringify(audit)).not.toContain(tinyPng);
    expect(audit.changes).toEqual({ displayNameChanged: true, logoChanged: true });
  });

  it("refuses empty names and missing changes before starting a transaction", async () => {
    const prisma = { tenant: { findUnique: vi.fn().mockResolvedValue({ id: "tenant-1" }) }, $transaction: vi.fn() };
    const service = new TenantsService(prisma as never, {} as never);
    await expect(service.updateBranding("tenant-1", { displayName: "   " }, {} as never)).rejects.toThrow(BadRequestException);
    await expect(service.updateBranding("tenant-1", {}, {} as never)).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
