import {
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AdminMcpAccessGuard } from "./admin-mcp-access.guard";

const adminId = "33333333-3333-4333-8333-333333333333";

function contextFor(
  request: Record<string, unknown>,
  reply: { header: ReturnType<typeof vi.fn> },
) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

function fixture(options: { platformAdmin?: boolean; authMode?: string } = {}) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "AUTH_MODE") return options.authMode ?? "oidc";
      if (key === "PLATFORM_ADMIN_USER_IDS") {
        return options.platformAdmin ? adminId : "";
      }
      if (key === "OIDC_ISSUER_URL") {
        return "https://auth.example.test";
      }
      return fallback;
    }),
  };
  const prisma = {
    userIdentity: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  return {
    guard: new AdminMcpAccessGuard(config as never, prisma as never),
    config,
    prisma,
  };
}

describe("AdminMcpAccessGuard", () => {
  it("allows anonymous MCP discovery before OAuth", async () => {
    const { guard } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      headers: {
        host: "resource-portal.test",
        "x-forwarded-proto": "https",
      },
      protocol: "http",
      url: "/api/platform/mcp",
    };

    await expect(
      guard.canActivate(contextFor(request, reply)),
    ).resolves.toBe(true);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it("rejects service identities", async () => {
    const { guard } = fixture({ platformAdmin: true });
    const reply = { header: vi.fn() };
    const request = {
      headers: { authorization: "Bearer service-token" },
      url: "/api/platform/mcp",
      serviceIdentity: { id: "service-id" },
      user: { id: adminId },
    };

    await expect(
      guard.canActivate(contextFor(request, reply)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects an authenticated non-platform-admin user", async () => {
    const { guard } = fixture();
    const reply = { header: vi.fn() };
    const request = {
      headers: { authorization: "Bearer user-token" },
      url: "/api/platform/mcp",
      user: { id: adminId },
    };

    await expect(
      guard.canActivate(contextFor(request, reply)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an interactive platform administrator", async () => {
    const { guard } = fixture({ platformAdmin: true });
    const reply = { header: vi.fn() };
    const request = {
      headers: { authorization: "Bearer admin-token" },
      url: "/api/platform/mcp",
      user: { id: adminId },
    };

    await expect(
      guard.canActivate(contextFor(request, reply)),
    ).resolves.toBe(true);
  });
});
