import { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { BillingPreflightGuard } from "./billing-preflight.guard";
import { BillingService } from "./billing.service";
import { PrismaService } from "../prisma/prisma.service";

function fixture() {
  const assertActivePriceList = vi.fn().mockResolvedValue(undefined);
  const volumeFind = vi.fn().mockResolvedValue({ sizeBytes: 1000n });
  const guard = new BillingPreflightGuard(
    { assertActivePriceList } as unknown as BillingService,
    { volume: { findFirst: volumeFind } } as unknown as PrismaService,
  );
  const check = (method: string, url: string, body: object = {}) => guard.canActivate({
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({
      routeOptions: { url }, method,
      params: { tenantId: "tenant-1", volumeId: "volume-1" }, body,
    }) }),
  } as unknown as ExecutionContext);
  return { check, assertActivePriceList, volumeFind };
}

describe("volume price-list preflight honors global /api prefix (#255)", () => {
  it("enforces price list on volume creation", async () => {
    const f = fixture();
    await f.check("POST", "/api/tenants/:tenantId/volumes");
    expect(f.assertActivePriceList).toHaveBeenCalledOnce();
  });
  it("enforces a price list on a growth resize but not a no-op", async () => {
    const f = fixture();
    await f.check("PATCH", "/api/tenants/:tenantId/volumes/:volumeId/resize", { sizeBytes: 2000 });
    expect(f.assertActivePriceList).toHaveBeenCalledOnce();
    expect(f.volumeFind).toHaveBeenCalledOnce();
    await f.check("PATCH", "/api/tenants/:tenantId/volumes/:volumeId/resize", { sizeBytes: 1000 });
    expect(f.assertActivePriceList).toHaveBeenCalledTimes(1);
  });
  it("propagates price-list preflight rejection before enqueue", async () => {
    const f = fixture();
    f.assertActivePriceList.mockRejectedValue(new Error("NoActivePriceList"));
    await expect(f.check("POST", "/api/tenants/:tenantId/volumes"))
      .rejects.toThrow("NoActivePriceList");
  });
});
