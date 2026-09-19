import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { REQUIRED_PERMISSIONS_KEY } from "../auth/auth.constants";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PlatformBillingController } from "./platform-billing.controller";
import { TenantsController } from "../tenants/tenants.controller";

describe("billing funding access policy", () => {
  it("does not expose tenant self-service balance top-up", () => {
    const prototype = TenantsController.prototype as unknown as Record<string, unknown>;
    expect(prototype.topUpBilling).toBeUndefined();
  });

  it("allows tenant funding only through voucher redemption permission", () => {
    const handler = TenantsController.prototype.redeemVoucher;
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler),
    ).toEqual(["billing.voucher.redeem"]);
  });

  it("keeps direct balance mutations behind PlatformAdminGuard", () => {
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, PlatformBillingController) as unknown[] | undefined) ??
      [];
    expect(guards).toContain(PlatformAdminGuard);
    expect(typeof PlatformBillingController.prototype.correction).toBe("function");
    expect(typeof PlatformBillingController.prototype.payment).toBe("function");
    expect(typeof PlatformBillingController.prototype.refund).toBe("function");
  });
});