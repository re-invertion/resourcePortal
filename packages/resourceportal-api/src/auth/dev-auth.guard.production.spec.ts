import { ConfigService } from "@nestjs/config";
import { ExecutionContext, InternalServerErrorException, ServiceUnavailableException } from "@nestjs/common";
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

describe("Public OIDC login remains reachable with an unrefreshable old cookie",()=>{
  const session={hasSessionCookie:vi.fn().mockReturnValue(true),
    getSessionIdFromRequest:vi.fn().mockReturnValue("stale-session"),
    authenticateSession:vi.fn().mockRejectedValue(new ServiceUnavailableException("OIDC refresh temporarily unavailable")),
    invalidateRequestSession:vi.fn(),clearSessionCookies:vi.fn()};
  const make=(isPublic:boolean)=>new DevAuthGuard(
    {getAllAndOverride:vi.fn((key:string)=>key==="isPublic"?isPublic:false)} as unknown as Reflector,
    {get:vi.fn((key:string)=>({AUTH_MODE:"oidc",NODE_ENV:"production"})[key as "AUTH_MODE"|"NODE_ENV"])} as unknown as ConfigService,
    {} as PrismaService,{} as OidcAuthService,session as unknown as AuthSessionService);
  const ctx=(url:string,method="GET")=>({getHandler:()=>function handler(){},getClass:()=>class Controller{},
    switchToHttp:()=>({getRequest:()=>({url,method,headers:{},params:{}}),getResponse:()=>({})})
  }) as unknown as ExecutionContext;
  it("starts only explicitly public interactive GET flows without refreshing prior session",async()=>{
    session.authenticateSession.mockClear();
    for(const path of ["/api/auth/login", "/api/auth/login?returnTo=%2F",
      "/api/auth/providers", "/api/auth/register", "/api/auth/recover"])
      await expect(make(true).canActivate(ctx(path))).resolves.toBe(true);
    expect(session.authenticateSession).not.toHaveBeenCalled();
  });
  it("does not bypass refresh for protected, POST or unrelated public routes",async()=>{
    for(const [path,method,publicFlag] of [
      ["/api/auth/login","GET",false], ["/api/auth/login","POST",true],
      ["/api/auth/me","GET",true], ["/api/tenants","GET",false],
    ] as const) await expect(make(publicFlag).canActivate(ctx(path,method))).rejects.toThrow(
      "OIDC refresh temporarily unavailable");
  });
});

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
