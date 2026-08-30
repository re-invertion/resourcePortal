import { describe, expect, it, vi } from "vitest";
import { AuthenticatedUser } from "./types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { OAuthApplicationCredentialsService } from "../oauth-applications/oauth-application-credentials.service";
import { ZitadelOAuthApplicationService } from "../oauth-applications/zitadel-oauth-application.service";
import { ServiceIdentityCredentialsService } from "../service-identities/service-identity-credentials.service";
import { ZitadelServiceIdentityService } from "../service-identities/zitadel-service-identity.service";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Platform Admin",
  status: "Active",
};

const encryption = {
  encrypt: vi.fn((value: string) => `enc:${value}`),
} as unknown as EncryptionService;

describe("Stage 1 credential rotation recovery", () => {
  it("returns an OAuth client secret with an explicit warning when local persistence fails", async () => {
    const prisma = {
      $executeRaw: vi.fn().mockRejectedValue(new Error("database unavailable")),
      auditLogEntry: { create: vi.fn() },
    } as unknown as PrismaService;
    const zitadel = {
      rotateSecret: vi.fn().mockResolvedValue("oauth-secret-v2"),
    } as unknown as ZitadelOAuthApplicationService;
    const service = new OAuthApplicationCredentialsService(prisma, encryption, zitadel);

    const rotate = service as unknown as {
      rotate: (
        application: {
          id: string;
          tenantId: string | null;
          name: string;
          type: string;
          zitadelApplicationId: string;
          clientId: string;
          clientSecretCiphertext: string | null;
        },
        actor: AuthenticatedUser,
        tenantId: string | null,
        tenantName: string,
      ) => Promise<Record<string, unknown>>;
    };

    await expect(
      rotate.rotate(
        {
          id: "22222222-2222-4222-8222-222222222222",
          tenantId: null,
          name: "platform-machine",
          type: "Machine",
          zitadelApplicationId: "zitadel-app-1",
          clientId: "oauth-client-1",
          clientSecretCiphertext: "enc:oauth-secret-v1",
        },
        actor,
        null,
        "platform",
      ),
    ).resolves.toMatchObject({
      clientId: "oauth-client-1",
      clientSecret: "oauth-secret-v2",
      persistenceStatus: "Failed",
      warning: expect.stringContaining("not persisted"),
    });
  });

  it("does not lose a persisted OAuth client secret when audit persistence fails", async () => {
    const prisma = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditLogEntry: { create: vi.fn().mockRejectedValue(new Error("audit unavailable")) },
    } as unknown as PrismaService;
    const zitadel = {
      rotateSecret: vi.fn().mockResolvedValue("oauth-secret-v2"),
    } as unknown as ZitadelOAuthApplicationService;
    const service = new OAuthApplicationCredentialsService(prisma, encryption, zitadel);
    const rotate = service as unknown as { rotate: (...args: unknown[]) => Promise<Record<string, unknown>> };

    await expect(
      rotate.rotate(
        {
          id: "22222222-2222-4222-8222-222222222222",
          tenantId: null,
          name: "platform-machine",
          type: "Machine",
          zitadelApplicationId: "zitadel-app-1",
          clientId: "oauth-client-1",
          clientSecretCiphertext: "enc:oauth-secret-v1",
        },
        actor,
        null,
        "platform",
      ),
    ).resolves.toMatchObject({
      clientSecret: "oauth-secret-v2",
      persistenceStatus: "Persisted",
      auditStatus: "Failed",
    });
  });

  it("returns a ServiceIdentity secret with an explicit warning when local persistence fails", async () => {
    const prisma = {
      $executeRaw: vi.fn().mockRejectedValue(new Error("database unavailable")),
      auditLogEntry: { create: vi.fn() },
    } as unknown as PrismaService;
    const zitadel = {
      rotateSecret: vi.fn().mockResolvedValue("service-secret-v2"),
    } as unknown as ZitadelServiceIdentityService;
    const service = new ServiceIdentityCredentialsService(prisma, encryption, zitadel);
    const rotate = service as unknown as { rotate: (...args: unknown[]) => Promise<Record<string, unknown>> };

    await expect(
      rotate.rotate(
        {
          id: "33333333-3333-4333-8333-333333333333",
          tenantId: null,
          name: "platform-worker",
          zitadelUserId: "zitadel-user-1",
          clientId: "service-client-1",
        },
        actor,
        null,
        "platform",
      ),
    ).resolves.toMatchObject({
      clientId: "service-client-1",
      clientSecret: "service-secret-v2",
      persistenceStatus: "Failed",
      warning: expect.stringContaining("not persisted"),
    });
  });
});
