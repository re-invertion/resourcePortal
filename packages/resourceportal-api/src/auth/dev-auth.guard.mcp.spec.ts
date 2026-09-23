import { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthSessionService } from "./auth-session.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { OidcAuthService } from "./oidc-auth.service";

function context(url: string) {
  const request = {
    url,
    protocol: "https",
    headers: {
      authorization: "Bearer mcp-token",
      host: "rp.example.test",
    },
    params: { tenantId: "00000000-0000-4000-8000-000000000001" },
  };
  const reply = { header: vi.fn() };
  return {
    request,
    reply,
    executionContext: {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ExecutionContext,
  };
}

function guard(oidcAuth: {
  authenticateMcpPrincipalToken: ReturnType<typeof vi.fn>;
  authenticatePrincipalToken: ReturnType<typeof vi.fn>;
}) {
  return new DevAuthGuard(
    { getAllAndOverride: vi.fn().mockReturnValue(true) } as unknown as Reflector,
    {
      get: vi.fn((key: string, fallback?: string) =>
        ({ AUTH_MODE: "oidc", NODE_ENV: "test" } as Record<string, string>)[key] ?? fallback,
      ),
    } as unknown as ConfigService,
    {} as PrismaService,
    oidcAuth as unknown as OidcAuthService,
    {
      hasSessionCookie: vi.fn().mockReturnValue(false),
      getSessionIdFromRequest: vi.fn().mockReturnValue(undefined),
    } as unknown as AuthSessionService,
  );
}

const userPrincipal = {
  type: "User" as const,
  user: {
    id: "00000000-0000-4000-8000-000000000002",
    email: "user@example.test",
    displayName: "User",
    status: UserStatus.Active,
  },
};

describe("DevAuthGuard MCP bearer authentication", () => {
  it("uses MCP-specific token validation for tenant MCP requests", async () => {
    const oidcAuth = {
      authenticateMcpPrincipalToken: vi.fn().mockResolvedValue(userPrincipal),
      authenticatePrincipalToken: vi.fn(),
    };
    const target = guard(oidcAuth);
    const { request, executionContext } = context(
      "/api/tenants/00000000-0000-4000-8000-000000000001/mcp",
    );

    await expect(target.canActivate(executionContext)).resolves.toBe(true);
    expect(oidcAuth.authenticateMcpPrincipalToken).toHaveBeenCalledWith("mcp-token");
    expect(oidcAuth.authenticatePrincipalToken).not.toHaveBeenCalled();
    expect(request).toMatchObject({ user: userPrincipal.user });
  });

  it("keeps ordinary bearer requests on the general token validation path", async () => {
    const oidcAuth = {
      authenticateMcpPrincipalToken: vi.fn(),
      authenticatePrincipalToken: vi.fn().mockResolvedValue(userPrincipal),
    };
    const target = guard(oidcAuth);
    const { executionContext } = context("/api/tenants/tenant-1/applications");

    await expect(target.canActivate(executionContext)).resolves.toBe(true);
    expect(oidcAuth.authenticatePrincipalToken).toHaveBeenCalledWith("mcp-token");
    expect(oidcAuth.authenticateMcpPrincipalToken).not.toHaveBeenCalled();
  });
});
