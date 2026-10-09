import { ConfigService } from "@nestjs/config";
import { ForbiddenException, ConflictException } from "@nestjs/common";
import { Prisma, UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcAuthService } from "./oidc-auth.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { TenantsService } from "../tenants/tenants.service";
import { ResourceBotBillingService } from "../resource-bot/resource-bot-billing.service";

describe("GitHub security issue regressions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries OIDC discovery after a transient failure (#234)", async () => {
    const issuer = "https://login.example.test";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer,
        jwks_uri: issuer + "/keys",
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new OidcAuthService({
      get: (key: string) => key === "OIDC_ISSUER_URL" ? issuer : undefined,
    } as ConfigService, {} as never);

    await expect(service.getDiscovery()).rejects.toThrow("OIDC discovery document is unavailable");
    await expect(service.getDiscovery()).resolves.toMatchObject({ issuer });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects Pending user bearer principals (#235)", async () => {
    const request = { url: "/api/tenants/x", headers: { authorization: "Bearer test" }, params: {} } as Record<string, unknown>;
    const guard = new DevAuthGuard(
      { getAllAndOverride: () => false } as never,
      { get: (key: string) => key === "AUTH_MODE" ? "oidc" : "test" } as ConfigService,
      {} as never,
      { authenticatePrincipalToken: vi.fn().mockResolvedValue({ type: "User", user: { status: UserStatus.Pending } }) } as never,
      {} as never,
    );
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }) } as never;
    await expect(guard.canActivate(context)).rejects.toThrow("Active user is required");
  });

  it("prevents Tenant Administrators granting themselves Owner (#233)", async () => {
    const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: tenantId, name: "acme" }) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "target" }) },
      role: { findMany: vi.fn().mockResolvedValue([{ id: "tenant-owner" }]) },
      tenantMembership: { findUnique: vi.fn().mockResolvedValue({
        status: "Active", roles: [{ roleId: "tenant-admin" }],
      }) },
      $transaction: vi.fn(),
    };
    const service = new TenantsService(prisma as never, {} as never);
    await expect(service.createMembership(tenantId, { userId: "target", roleIds: ["tenant-owner"] }, {
      id: "admin", email: "admin@example.test", displayName: "Admin", status: UserStatus.Active,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not reuse another tenant's ResourceBot usage requestId (#225)", async () => {
    const price = {
      id: "price-1", inputCreditsPer1M: new Prisma.Decimal("2"),
      cachedInputCreditsPer1M: new Prisma.Decimal("1"),
      outputCreditsPer1M: new Prisma.Decimal("4"),
      embeddingCreditsPer1M: new Prisma.Decimal("1"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: "account-1", tenantId: "tenant-a",
        balance: new Prisma.Decimal(100), informationThreshold: new Prisma.Decimal(0),
      }]),
      resourceBotUsageRecord: { findUnique: vi.fn().mockResolvedValue({
        id: "usage-b", tenantId: "tenant-b", chargedCredits: new Prisma.Decimal(1),
      }) },
    };
    const prisma = {
      resourceBotPriceVersion: { findFirst: vi.fn().mockResolvedValue(price) },
      $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const service = new ResourceBotBillingService(prisma as never);
    await expect(service.reserve({ tenantId: "tenant-a", requestId: "same-key", provider: "openai", model: "model" }))
      .rejects.toBeInstanceOf(ConflictException);
  });
});
