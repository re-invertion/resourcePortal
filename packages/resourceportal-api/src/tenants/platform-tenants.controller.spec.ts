import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PlatformTenantsController } from "./platform-tenants.controller";

describe("PlatformTenantsController access", () => {
  it("is protected by PlatformAdminGuard", () => {
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, PlatformTenantsController) as unknown[] | undefined) ?? [];
    expect(guards).toContain(PlatformAdminGuard);
  });
});
