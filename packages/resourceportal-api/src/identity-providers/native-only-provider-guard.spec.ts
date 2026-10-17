import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { IdentityProvidersController } from "./identity-providers.controller";
import { PlatformIdentityProvidersController } from "./platform-identity-providers.controller";
import type { IdentityProvidersService } from "./identity-providers.service";
import type { PlatformIdentityProvidersService } from "./platform-identity-providers.service";
import type { FederationRetirementService } from "./federation-retirement.service";

const cfg = { get: (key: string) => key === "RP_NATIVE_LOGIN_ONLY" ? "true" : undefined } as ConfigService;

describe("Retired inbound identity provider administration", () => {
  it("denies creation and updates in tenant configuration", async () => {
    const service = { createTenantIdentityProvider: vi.fn(), updateTenantIdentityProvider: vi.fn() };
    const controller = new IdentityProvidersController(
      service as unknown as IdentityProvidersService, cfg,
    );
    await expect(controller.create("tenant", {} as never, {} as never)).rejects.toThrow(
      "Incoming identity provider configuration has been retired",
    );
    await expect(controller.update("tenant", "idp", {}, {} as never)).rejects.toThrow();
    expect(service.createTenantIdentityProvider).not.toHaveBeenCalled();
    expect(service.updateTenantIdentityProvider).not.toHaveBeenCalled();
  });

  it("denies platform creates and updates without mutating ZITADEL", async () => {
    const service = { create: vi.fn(), update: vi.fn() };
    const controller = new PlatformIdentityProvidersController(
      service as unknown as PlatformIdentityProvidersService,
      {} as FederationRetirementService,
      cfg,
    );
    await expect(controller.create({} as never, {} as never)).rejects.toThrow();
    await expect(controller.update("idp", {}, {} as never)).rejects.toThrow();
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });
});
