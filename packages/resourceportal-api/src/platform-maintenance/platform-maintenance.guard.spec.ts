import {
  ExecutionContext,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { PlatformMaintenanceGuard } from "./platform-maintenance.guard";
import { PlatformMaintenanceService } from "./platform-maintenance.service";

describe("PlatformMaintenanceGuard", () => {
  it("rejects ordinary requests while platform maintenance is enabled", async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const service = {
      getState: vi.fn().mockResolvedValue({
        enabled: true,
        reason: "control plane upgrade",
      }),
    } as unknown as PlatformMaintenanceService;
    const guard = new PlatformMaintenanceGuard(reflector, service);

    let caught: unknown;
    try {
      await guard.canActivate(httpContext());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    if (!(caught instanceof ServiceUnavailableException)) {
      throw new Error("Expected ServiceUnavailableException");
    }
    expect(caught.getResponse()).toMatchObject({
      code: "PLATFORM_MAINTENANCE",
      reason: "control plane upgrade",
    });
  });

  it("allows routes explicitly marked as available during maintenance", async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const service = {
      getState: vi.fn(),
    } as unknown as PlatformMaintenanceService;
    const guard = new PlatformMaintenanceGuard(reflector, service);

    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(service.getState).not.toHaveBeenCalled();
  });

  it("allows ordinary requests when maintenance is disabled", async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const service = {
      getState: vi.fn().mockResolvedValue({ enabled: false, reason: null }),
    } as unknown as PlatformMaintenanceService;
    const guard = new PlatformMaintenanceGuard(reflector, service);

    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
  });
});

function httpContext() {
  return {
    getType: () => "http",
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}
