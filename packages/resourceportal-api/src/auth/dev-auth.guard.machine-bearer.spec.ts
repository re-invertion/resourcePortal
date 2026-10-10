/* eslint-disable @typescript-eslint/unbound-method -- Test inspects controller handler metadata, never invokes unbound methods. */
import "reflect-metadata";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import {
  DeviceVpnRuntimeController,
  GateAgentController,
} from "../networking/networking.controller";
import { AuthSessionService } from "./auth-session.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { MachineBearerAuth } from "./machine-bearer-auth.decorator";
import { OidcAuthService } from "./oidc-auth.service";

function fixture() {
  const oidc = {
    authenticatePrincipalToken: vi.fn().mockRejectedValue(new UnauthorizedException("Invalid OIDC token")),
    authenticateMcpPrincipalToken: vi.fn(),
  };
  const guard = new DevAuthGuard(
    new Reflector(),
    { get: vi.fn((key: string, fallback?: string) =>
      ({ AUTH_MODE: "oidc", NODE_ENV: "production" } as Record<string, string>)[key] ?? fallback,
    ) } as unknown as ConfigService,
    {} as PrismaService,
    oidc as unknown as OidcAuthService,
    {
      hasSessionCookie: vi.fn().mockReturnValue(false),
      getSessionIdFromRequest: vi.fn().mockReturnValue(undefined),
    } as unknown as AuthSessionService,
  );
  return { guard, oidc };
}

function context(controller: object, handler: (...args: never[]) => unknown): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        url: "/api/networking/gates/agent/heartbeat",
        headers: { authorization: "Bearer opaque-gate-token" },
      }),
      getResponse: () => ({ header: vi.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe("opaque machine bearer endpoints (OIDC mode)", () => {
  it.each([
    ["Site VPN heartbeat", GateAgentController, GateAgentController.prototype.heartbeat],
    ["Site VPN agent config", GateAgentController, GateAgentController.prototype.config],
    ["Device VPN runtime heartbeat", DeviceVpnRuntimeController, DeviceVpnRuntimeController.prototype.heartbeat],
  ] as const)("lets %s reach its own machine-token validator", async (_label, controller, handler) => {
    const { guard, oidc } = fixture();
    await expect(guard.canActivate(context(controller, handler))).resolves.toBe(true);
    expect(oidc.authenticatePrincipalToken).not.toHaveBeenCalled();
    expect(oidc.authenticateMcpPrincipalToken).not.toHaveBeenCalled();
  });

  it("does not bypass OIDC for an ordinary public endpoint receiving a bearer", async () => {
    const { guard, oidc } = fixture();
    await expect(guard.canActivate(
      context(GateAgentController, GateAgentController.prototype.enroll),
    )).rejects.toThrow("Invalid OIDC token");
    expect(oidc.authenticatePrincipalToken).toHaveBeenCalledWith("opaque-gate-token");
  });

  it("never bypasses authentication on a non-public route even if accidentally marked", async () => {
    class PrivateController {
      @MachineBearerAuth()
      protectedEndpoint() { return true; }
    }
    const { guard, oidc } = fixture();
    await expect(guard.canActivate(
      context(PrivateController, PrivateController.prototype.protectedEndpoint),
    )).rejects.toThrow("Invalid OIDC token");
    expect(oidc.authenticatePrincipalToken).toHaveBeenCalledOnce();
  });
});
