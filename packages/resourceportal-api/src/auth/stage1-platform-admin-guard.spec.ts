import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { PlatformAdminGuard } from "./platform-admin.guard";

function contextWithRequest(request: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("Stage 1 platform ServiceIdentity authorization", () => {
  it("does not implicitly grant platform administrator access to a platform ServiceIdentity", () => {
    const config = {
      get: () => "platform-admin-user",
    } as unknown as ConfigService;
    const guard = new PlatformAdminGuard(config);

    const activate = () =>
      guard.canActivate(
        contextWithRequest({
          serviceIdentity: {
            id: "service-identity-1",
            tenantId: null,
            status: "Active",
          },
        }),
      );

    expect(activate).toThrow(ForbiddenException);
  });
});
