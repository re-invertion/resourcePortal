import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TenantMcpAccessGuard } from "./tenant-mcp-access.guard";

function contextFor(request: Record<string, unknown>, reply: { header: ReturnType<typeof vi.fn> }) {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

function fixture(authMode = "oidc") {
  const settings = { assertUserCanUseMcp: vi.fn().mockResolvedValue({ id: "membership-id" }) };
  const config = { get: vi.fn((key: string, fallback?: unknown) => key === "AUTH_MODE" ? authMode : fallback) };
  return { guard: new TenantMcpAccessGuard(settings as never, config as never), settings };
}

describe("TenantMcpAccessGuard", () => {
  it("requires an OAuth bearer token in production and publishes a resource metadata challenge", async () => {
    const { guard } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      params: { tenantId: "22222222-2222-4222-8222-222222222222" },
      headers: { host: "portal.example.com", "x-forwarded-proto": "https" },
      protocol: "http",
      user: { id: "user-id" },
    };
    await expect(guard.canActivate(contextFor(request, reply))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reply.header).toHaveBeenCalledWith(
      "www-authenticate",
      expect.stringContaining("https://portal.example.com/.well-known/oauth-protected-resource/api/tenants/22222222-2222-4222-8222-222222222222/mcp"),
    );
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
    expect(settings.assertUserCanUseMcp).toHaveBeenCalledWith("tenant-id", "user-id");
  });
});
