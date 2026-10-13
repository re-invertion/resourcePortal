import { UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { AuthSessionService } from "./auth-session.service";
import { DevAuthGuard } from "./dev-auth.guard";
import type { OidcAuthService } from "./oidc-auth.service";
import type { NativeLoginModeService } from "./native-login-mode.service";

const person = { id: "user-1", email: "user@rp.test", displayName: "Test", status: UserStatus.Active };
const mode = { isNativeOnly: vi.fn().mockResolvedValue(true) };
const cfg = { get: (key: string, fallback?: string) => ({ AUTH_MODE: "oidc", NODE_ENV: "test", RP_NATIVE_LOGIN_ONLY: "auto" } as Record<string, string>)[key] ?? fallback };

function guardFixture({ bearer = true, mcp = false, federated = true } = {}) {
  const request = {
    url: mcp ? "/api/platform/mcp" : "/api/users/me",
    protocol: "https",
    headers: bearer ? { authorization: "Bearer signed-oidc", host: "rp.test" } : { host: "rp.test" },
    params: {},
    cookies: bearer ? {} : { rp_session: "session-1" },
  };
  const reply = { clearCookie: vi.fn(), header: vi.fn() };
  const oidc = {
    authenticatePrincipalToken: vi.fn().mockResolvedValue({ type: "User", user: {
      ...person, authenticatedIdpId: federated ? "external-idp" : null,
    } }),
    authenticateMcpPrincipalToken: vi.fn().mockResolvedValue({ type: "User", user: {
      ...person, authenticatedIdpId: federated ? "external-idp" : null,
    } }),
  };
  const sessions = {
    hasSessionCookie: vi.fn().mockReturnValue(!bearer),
    getSessionIdFromRequest: vi.fn().mockReturnValue(bearer ? undefined : "session-1"),
    authenticateSession: vi.fn().mockResolvedValue({
      ...person, authenticatedIdpId: federated ? "external-idp" : null,
    }),
    invalidateRequestSession: vi.fn().mockResolvedValue(undefined),
  };
  const guard = new DevAuthGuard(
    { getAllAndOverride: vi.fn().mockReturnValue(false) } as unknown as Reflector,
    cfg as unknown as ConfigService,
    {} as PrismaService,
    oidc as unknown as OidcAuthService,
    sessions as unknown as AuthSessionService,
    mode as unknown as NativeLoginModeService,
  );
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class FakeController {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  return { guard, context, oidc, sessions, request };
}

describe("native-only enforcement at all shared authentication entrances", () => {
  it.each([{ mcp: false }, { mcp: true }])("refuses federated bearer (mcp=$mcp)", async ({ mcp }) => {
    const f = guardFixture({ mcp });
    await expect(f.guard.canActivate(f.context)).rejects.toThrow("External identity provider login is disabled");
    expect(f.request).not.toHaveProperty("user");
    expect(mcp ? f.oidc.authenticateMcpPrincipalToken : f.oidc.authenticatePrincipalToken).toHaveBeenCalledOnce();
  });
  it("refuses old external session cookies and invalidates them", async () => {
    const f = guardFixture({ bearer: false });
    await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.sessions.invalidateRequestSession).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveProperty("user");
  });
  it("keeps native tokens and native cookies working", async () => {
    const f1 = guardFixture({ federated: false });
    const f2 = guardFixture({ bearer: false, federated: false });
    await expect(f1.guard.canActivate(f1.context)).resolves.toBe(true);
    await expect(f2.guard.canActivate(f2.context)).resolves.toBe(true);
    expect(f2.sessions.invalidateRequestSession).not.toHaveBeenCalled();
  });
  it("direct session authentication revokes a federated session before refreshing tokens", async () => {
    const prisma = {
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1", userId: "user-1", revokedAt: null,
          expiresAt: new Date(Date.now() + 120000),
          lastSeenAt: new Date(),
          accessTokenExpiresAt: new Date(Date.now() - 1000),
          authenticatedIdpId: "external-idp", user: person,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      auditLogEntry: { create: vi.fn() },
    };
    const oidc = { getDiscovery: vi.fn() };
    const svc = new AuthSessionService(
      cfg as unknown as ConfigService,
      prisma as unknown as PrismaService,
      oidc as unknown as OidcAuthService,
      { encrypt: vi.fn(), decrypt: vi.fn() } as unknown as EncryptionService,
      mode as unknown as NativeLoginModeService,
    );
    await expect(svc.authenticateSession("session-1")).rejects.toThrow("External identity provider login is disabled");
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session-1", revokedAt: null },
    }));
    expect(prisma.portalSession.update).not.toHaveBeenCalled();
    expect(oidc.getDiscovery).not.toHaveBeenCalled();
  });
});
