import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { FederationRetirementService } from "./federation-retirement.service";

function fixture() {
  const prisma = {
    identityProvider: { count: vi.fn().mockResolvedValue(2) },
    tenantAuthPolicy: { count: vi.fn().mockResolvedValue(1) },
    portalSession: { count: vi.fn().mockResolvedValue(3) },
    userIdentity: {
      findMany: vi.fn()
        .mockResolvedValueOnce([{ userId: "user-a" }, { userId: "user-b" }])
        .mockResolvedValueOnce([{ userId: "user-a" }]),
    },
  };
  const config = {
    get: (key: string) => ({
      OIDC_ISSUER_URL: "https://login.example.com/",
      RP_NATIVE_LOGIN_ONLY: "false",
    } as Record<string, string>)[key],
  };
  return {
    prisma,
    service: new FederationRetirementService(
      prisma as unknown as PrismaService,
      config as ConfigService,
    ),
  };
}

describe("Inbound federation retirement preflight", () => {
  it("blocks automatic cutover when federated-only users and policies remain", async () => {
    const f = fixture();
    const result = await f.service.preflight();
    expect(result).toMatchObject({
      safeToCutoverAutomatically: false,
      enabledProviders: 2,
      mandatoryTenantPolicies: 1,
      externalSessions: 3,
      federatedUsers: 2,
      usersWithoutNativeLink: 1,
    });
    expect(result.blockers).toContain("Federated users lack native identity links");
    expect(f.prisma.userIdentity.findMany).toHaveBeenCalledTimes(2);
    expect(f.prisma.userIdentity.findMany).toHaveBeenLastCalledWith({
      where: {
        userId: { in: ["user-a", "user-b"] },
        issuer: "https://login.example.com",
        providerType: "zitadel",
        identityProviderId: null,
      },
      select: { userId: true },
      distinct: ["userId"],
    });
  });
  it("reports manual verification even when all database blockers are gone", async () => {
    const f = fixture();
    f.prisma.identityProvider.count.mockResolvedValue(0);
    f.prisma.tenantAuthPolicy.count.mockResolvedValue(0);
    f.prisma.portalSession.count.mockResolvedValue(0);
    f.prisma.userIdentity.findMany.mockReset().mockResolvedValue([]);
    const result = await f.service.preflight();
    expect(result.safeToCutoverAutomatically).toBe(false);
    expect(result.blockers.some((value: string) => value.includes("Operator must verify"))).toBe(true);
  });
});
