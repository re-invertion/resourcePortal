import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PlatformUsersController } from "./platform-users.controller";

describe("PlatformUsersController access", () => {
  it("is protected by PlatformAdminGuard", () => {
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, PlatformUsersController) as unknown[] | undefined) ?? [];
    expect(guards).toContain(PlatformAdminGuard);
  });
});
