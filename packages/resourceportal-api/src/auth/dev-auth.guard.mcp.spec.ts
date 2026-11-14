import { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "./auth.constants";
import { AuthSessionService } from "./auth-session.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { OidcAuthService } from "./oidc-auth.service";
import { McpResourceOAuthService } from "./mcp-resource-oauth.service";

function context(url: string, method = "POST") {
  const request = {
    url,
    method,
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
    { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) } as unknown as Reflector,
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
  it.each([
    ["GET", "/api/mcp/oauth/authorize?client_id=abc"],
    ["GET", "/api/mcp/oauth/upstream/callback?state=abc&code=def"],
    ["POST", "/api/mcp/oauth/approve"],
  ])("allows dedicated MCP-only authorization (%s %s) despite a stale RP Web session", async (method, url) => {
    const sessions = {
      hasSessionCookie: vi.fn().mockReturnValue(true),
      getSessionIdFromRequest: vi.fn().mockReturnValue("stale-rp-web-session"),
      authenticateSession: vi.fn().mockRejectedValue(Error("No native RP Web grant")),
    };
    const mcp = new DevAuthGuard(
      { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) } as unknown as Reflector,
      { get: vi.fn((key: string, fallback?: string) =>
        ({ AUTH_MODE: "oidc", NODE_ENV: "test" } as Record<string, string>)[key] ?? fallback),
      } as unknown as ConfigService,
      {} as PrismaService,
      {} as OidcAuthService,
      sessions as unknown as AuthSessionService,
    );
    const req = context(url, method);
    delete (req.request.headers as { authorization?: string }).authorization;
    await expect(mcp.canActivate(req.executionContext)).resolves.toBe(true);
    expect(sessions.authenticateSession).not.toHaveBeenCalled();
  });

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
    expect(oidcAuth.authenticateMcpPrincipalToken).toHaveBeenCalledWith("mcp-token", false);
    expect(oidcAuth.authenticatePrincipalToken).not.toHaveBeenCalled();
    expect(request).toMatchObject({ user: userPrincipal.user });
  });

  it("uses the exact RP resource-bound token when native MCP OAuth is enabled", async () => {
    const oidc = {
      authenticateMcpPrincipalToken: vi.fn(), authenticatePrincipalToken: vi.fn(),
    };
    const user = userPrincipal.user;
    const resourceOAuth = {
      isEnabled: vi.fn().mockReturnValue(true),
      authenticateAccessToken: vi.fn().mockResolvedValue(user),
    };
    const mcp = new DevAuthGuard(
      { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) } as unknown as Reflector,
      { get: vi.fn((key: string, fallback?: string) =>
        ({ AUTH_MODE: "oidc", NODE_ENV: "test" } as Record<string, string>)[key] ?? fallback),
      } as unknown as ConfigService,
      {} as PrismaService,
      oidc as unknown as OidcAuthService,
      { hasSessionCookie: vi.fn().mockReturnValue(false), getSessionIdFromRequest: vi.fn() } as unknown as AuthSessionService,
      undefined,
      resourceOAuth as unknown as McpResourceOAuthService,
    );
    const { executionContext, request } = context(
      "/api/tenants/00000000-0000-4000-8000-000000000001/mcp",
    );
    await expect(mcp.canActivate(executionContext)).resolves.toBe(true);
    expect(resourceOAuth.authenticateAccessToken).toHaveBeenCalledWith("mcp-token",
      "00000000-0000-4000-8000-000000000001");
    expect(oidc.authenticateMcpPrincipalToken).not.toHaveBeenCalled();
    expect(request).toMatchObject({ user });
  });

  it("denies legacy ZITADEL bearer tokens on tenant MCP after the resource-bound cutover", async () => {
    const oidc = {
      authenticateMcpPrincipalToken: vi.fn().mockResolvedValue(userPrincipal),
      authenticatePrincipalToken: vi.fn(),
    };
    const resourceOAuth = {
      isEnabled: vi.fn().mockReturnValue(true),
      authenticateAccessToken: vi.fn().mockRejectedValue(new Error("not RP resource token")),
    };
    const mcp = new DevAuthGuard(
      { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) } as unknown as Reflector,
      { get: vi.fn((key: string, fallback?: string) =>
        ({ AUTH_MODE: "oidc", NODE_ENV: "test" } as Record<string, string>)[key] ?? fallback),
      } as unknown as ConfigService,
      {} as PrismaService,
      oidc as unknown as OidcAuthService,
      { hasSessionCookie: vi.fn().mockReturnValue(false), getSessionIdFromRequest: vi.fn() } as unknown as AuthSessionService,
      undefined,
      resourceOAuth as unknown as McpResourceOAuthService,
    );
    await expect(mcp.canActivate(context(
      "/api/tenants/00000000-0000-4000-8000-000000000001/mcp",
    ).executionContext)).rejects.toThrow("not RP resource token");
    expect(oidc.authenticateMcpPrincipalToken).not.toHaveBeenCalled();
  });

  it("uses MCP-specific token validation for Platform Admin MCP requests", async () => {
    const oidcAuth = {
      authenticateMcpPrincipalToken: vi.fn().mockResolvedValue(userPrincipal),
      authenticatePrincipalToken: vi.fn(),
    };
    const target = guard(oidcAuth);
    const { request, executionContext } = context("/api/platform/mcp");

    await expect(target.canActivate(executionContext)).resolves.toBe(true);
    expect(oidcAuth.authenticateMcpPrincipalToken).toHaveBeenCalledWith("mcp-token", false);
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
    expect(oidcAuth.authenticatePrincipalToken).toHaveBeenCalledWith("mcp-token", false);
    expect(oidcAuth.authenticateMcpPrincipalToken).not.toHaveBeenCalled();
  });
});
