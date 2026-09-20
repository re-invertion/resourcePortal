import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformAdminGuard } from "./platform-admin.guard";

function contextWithRequest(request: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createConfig(values: Record<string, string | undefined>) {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createPrisma(matchingIdentity: { id: string } | null = null) {
  return {
    userIdentity: {
      findFirst: vi.fn().mockResolvedValue(matchingIdentity),
    },
  };
}

describe("Stage 1 platform administrator authorization", () => {
  it("does not implicitly grant platform administrator access to a platform ServiceIdentity", async () => {
    const config = createConfig({
      PLATFORM_ADMIN_USER_IDS: "platform-admin-user",
      OIDC_ISSUER_URL: "https://auth.example.com",
    });
    const prisma = createPrisma();
    const guard = new PlatformAdminGuard(
      config,
      prisma as unknown as PrismaService,
    );

    await expect(
      guard.canActivate(
        contextWithRequest({
          user: {
            id: "service-identity-1",
          },
          serviceIdentity: {
            id: "service-identity-1",
            tenantId: null,
            status: "Active",
          },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.userIdentity.findFirst).not.toHaveBeenCalled();
  });

  it("accepts an internal ResourcePortal User id for backward-compatible configuration", async () => {
    const config = createConfig({
      PLATFORM_ADMIN_USER_IDS: "rp-user-uuid",
      OIDC_ISSUER_URL: "https://auth.example.com",
    });
    const prisma = createPrisma();
    const guard = new PlatformAdminGuard(
      config,
      prisma as unknown as PrismaService,
    );

    await expect(
      guard.canActivate(
        contextWithRequest({
          user: {
            id: "rp-user-uuid",
          },
        }),
      ),
    ).resolves.toBe(true);
    expect(prisma.userIdentity.findFirst).not.toHaveBeenCalled();
  });

  it("accepts the installer-provisioned ZITADEL user id through the primary OIDC identity", async () => {
    const config = createConfig({
      PLATFORM_ADMIN_USER_IDS: "390305436340846862",
      OIDC_ISSUER_URL: "https://auth.example.com/",
    });
    const prisma = createPrisma({ id: "identity-1" });
    const guard = new PlatformAdminGuard(
      config,
      prisma as unknown as PrismaService,
    );

    await expect(
      guard.canActivate(
        contextWithRequest({
          user: {
            id: "6028cd9b-4869-40eb-b3aa-cf4092a43ded",
          },
        }),
      ),
    ).resolves.toBe(true);
    expect(prisma.userIdentity.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "6028cd9b-4869-40eb-b3aa-cf4092a43ded",
        issuer: "https://auth.example.com",
        externalSubject: {
          in: ["390305436340846862"],
        },
      },
      select: {
        id: true,
      },
    });
  });

  it("rejects a configured external subject that is not linked to the authenticated user", async () => {
    const config = createConfig({
      PLATFORM_ADMIN_USER_IDS: "390305436340846862",
      OIDC_ISSUER_URL: "https://auth.example.com",
    });
    const prisma = createPrisma(null);
    const guard = new PlatformAdminGuard(
      config,
      prisma as unknown as PrismaService,
    );

    await expect(
      guard.canActivate(
        contextWithRequest({
          user: {
            id: "different-rp-user",
          },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("does not resolve external platform-admin ids against an unspecified issuer", async () => {
    const config = createConfig({
      PLATFORM_ADMIN_USER_IDS: "390305436340846862",
    });
    const prisma = createPrisma({ id: "identity-1" });
    const guard = new PlatformAdminGuard(
      config,
      prisma as unknown as PrismaService,
    );

    await expect(
      guard.canActivate(
        contextWithRequest({
          user: {
            id: "rp-user-uuid",
          },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.userIdentity.findFirst).not.toHaveBeenCalled();
  });
});
