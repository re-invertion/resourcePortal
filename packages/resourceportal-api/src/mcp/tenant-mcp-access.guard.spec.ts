import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TenantMcpAccessGuard } from "./tenant-mcp-access.guard";

function contextFor(request: Record<string, unknown>, reply: { header: ReturnType<typeof vi.fn> }) {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

function fixture(authMode = "oidc") {
  const settings = {
    assertMcpEnabled: vi.fn().mockResolvedValue(undefined),
    assertUserCanUseMcp: vi.fn().mockResolvedValue({ id: "membership-id" }),
  };
  const config = { get: vi.fn((key: string, fallback?: unknown) => key === "AUTH_MODE" ? authMode : fallback) };
  const prisma = {
    tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue({
      requireTenantIdentityProvider: false, allowPlatformLogin: true,
    }) },
    identityProvider: { findFirst: vi.fn().mockResolvedValue({ id: "idp-1" }) },
  };
  const nativeMode = { isNativeOnly: vi.fn().mockResolvedValue(false) };
  return {
    guard: new TenantMcpAccessGuard(
      settings as never, config as never, prisma as never, nativeMode as never,
    ),
    settings, prisma, nativeMode,
  };
}

describe("TenantMcpAccessGuard", () => {
  it("allows anonymous MCP discovery before OAuth while still requiring tenant MCP to be enabled", async () => {
    const { guard, settings } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      params: { tenantId: "22222222-2222-4222-8222-222222222222" },
      headers: { host: "portal.example.com", "x-forwarded-proto": "https" },
      protocol: "http",
    };
    await expect(guard.canActivate(contextFor(request, reply))).resolves.toBe(true);
    expect(settings.assertMcpEnabled).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(settings.assertUserCanUseMcp).not.toHaveBeenCalled();
    expect(reply.header).not.toHaveBeenCalled();
  });

  it("rejects service identities even when they have a bearer token", async () => {
    const { guard } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer service-token" },
      serviceIdentity: { id: "service-id" },
      user: { id: "service-user" },
    };
    await expect(guard.canActivate(contextFor(request, reply))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("checks tenant MCP allow-list for an interactive bearer-authenticated user", async () => {
    const { guard, settings } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer user-token" },
      user: { id: "user-id" },
    };
    await expect(guard.canActivate(contextFor(request, reply))).resolves.toBe(true);
    expect(settings.assertMcpEnabled).toHaveBeenCalledWith("tenant-id");
    expect(settings.assertUserCanUseMcp).toHaveBeenCalledWith("tenant-id", "user-id");
  });
  it("denies a valid interactive bearer when MCP is disabled for this tenant", async () => {
    const f = fixture();
    f.settings.assertMcpEnabled.mockRejectedValue(new ForbiddenException("Tenant MCP is disabled"));
    const req = { params: { tenantId: "disabled-tenant" },
      headers: { authorization: "Bearer signed-user-token" }, user: { id: "user-id" } };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).rejects.toThrow(
      "Tenant MCP is disabled",
    );
    expect(f.settings.assertUserCanUseMcp).not.toHaveBeenCalled();
  });

  it("enforces tenant-specific user MCP allowlist at request time, including cross-tenant bearer reuse", async () => {
    const f = fixture();
    const actor = { headers: { authorization: "Bearer same-user-token" }, user: { id: "user-a" } };
    f.settings.assertUserCanUseMcp.mockImplementation(async (tenantId: string, userId: string) => {
      if (tenantId !== "tenant-a" || userId !== "user-a") {
        throw new ForbiddenException("Current tenant does not grant MCP access");
      }
      return { id: "membership-id" };
    });
    await expect(f.guard.canActivate(contextFor({ ...actor, params: { tenantId: "tenant-a" } },
      { header: vi.fn() }))).resolves.toBe(true);
    await expect(f.guard.canActivate(contextFor({ ...actor, params: { tenantId: "tenant-b" } },
      { header: vi.fn() }))).rejects.toThrow("Current tenant does not grant MCP access");
    expect(f.settings.assertUserCanUseMcp).toHaveBeenCalledWith("tenant-a", "user-a");
    expect(f.settings.assertUserCanUseMcp).toHaveBeenCalledWith("tenant-b", "user-a");
  });

  it("denies MCP bearer authentication from platform IdP when tenant policy disables it", async () => {
    const f = fixture();
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false, allowPlatformLogin: false,
    });
    const req = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer signed-user-token" },
      user: { id: "user-id" },
    };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).rejects.toThrow(
      "requires a verified tenant identity provider",
    );
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });

  it("allows MCP bearer only after verified enabled tenant IdP provenance", async () => {
    const f = fixture();
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: true, allowPlatformLogin: false,
    });
    const req = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer signed-user-token" },
      user: { id: "user-id", authenticatedIdpId: "zitadel-tenant-idp" },
    };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).toHaveBeenCalledWith({
      where: {
        scope: "Tenant", tenantId: "tenant-id", enabled: true,
        zitadelIdentityProviderId: "zitadel-tenant-idp",
      },
      select: { id: true },
    });
    f.prisma.identityProvider.findFirst.mockResolvedValue(null);
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).rejects.toThrow(
      "Login did not use an enabled identity provider",
    );
  });

  it("blocks tenant-sourced MCP tokens when tenant providers are disabled", async () => {
    const f = fixture();
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false, allowPlatformLogin: true,
      allowTenantIdentityProviders: false,
    });
    f.prisma.identityProvider.findFirst.mockResolvedValue(null);
    const req = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer verified-user-token" },
      user: { id: "user-id", authenticatedIdpId: "zitadel-tenant-idp" },
    };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).rejects.toThrow(
      "Tenant identity provider login is disabled",
    );
  });
  it("keeps native tenant MCP working when tenant IdPs are disabled and platform login allowed", async () => {
    const f = fixture();
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false, allowPlatformLogin: true,
      allowTenantIdentityProviders: false,
    });
    const req = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer signed-native-token" },
      user: { id: "user-id" },
    };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });

  it("continues to allow native MCP login after intentional native-only cutover", async () => {
    const f = fixture();
    f.nativeMode.isNativeOnly.mockResolvedValue(true);
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: true, allowPlatformLogin: false,
    });
    const req = {
      params: { tenantId: "tenant-id" },
      headers: { authorization: "Bearer native-user-token" },
      user: { id: "user-id" },
    };
    await expect(f.guard.canActivate(contextFor(req, { header: vi.fn() }))).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });
});
