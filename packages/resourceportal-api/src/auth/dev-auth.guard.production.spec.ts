import { ConfigService } from "@nestjs/config";
import { ExecutionContext, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthSessionService } from "./auth-session.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { OidcAuthService } from "./oidc-auth.service";

function context() {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { "x-dev-user-id": "00000000-0000-4000-8000-000000000001" },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("DevAuthGuard production fail-closed", () => {
  it("refuses dev auth in production even if ConfigModule validation was bypassed", async () => {
    const prisma = { user: { findUnique: vi.fn() } };
    const guard = new DevAuthGuard(
      { getAllAndOverride: vi.fn().mockReturnValue(true) } as unknown as Reflector,
      {
        get: vi.fn((key: string, fallback?: string) =>
          ({ AUTH_MODE: "dev", NODE_ENV: "production" } as Record<string, string>)[key] ?? fallback,
        ),
      } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as OidcAuthService,
      {} as AuthSessionService,
    );

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("normalizes case and whitespace before applying the production guard", async () => {
    const guard = new DevAuthGuard(
      { getAllAndOverride: vi.fn().mockReturnValue(true) } as unknown as Reflector,
      {
        get: vi.fn((key: string, fallback?: string) =>
          ({ AUTH_MODE: " DEV ", NODE_ENV: " Production " } as Record<string, string>)[key] ?? fallback,
        ),
      } as unknown as ConfigService,
      { user: { findUnique: vi.fn() } } as unknown as PrismaService,
      {} as OidcAuthService,
      {} as AuthSessionService,
    );

    await expect(guard.canActivate(context())).rejects.toThrow(
      "AUTH_MODE=dev is not allowed in production",
    );
  });
});
