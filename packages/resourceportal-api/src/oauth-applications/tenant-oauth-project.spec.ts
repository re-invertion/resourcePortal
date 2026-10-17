import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { OAuthApplicationsService } from "./oauth-applications.service";
import type { ZitadelOAuthApplicationService } from "./zitadel-oauth-application.service";

function fixture(enabled = false) {
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: "t", name: "Tenant" }) },
    tenantOidcProvider: { findUnique: vi.fn().mockResolvedValue({
      enabled, status: enabled ? "Active" : "PendingGrants",
      zitadelProjectId: "tenant-project", grantsReconciledAt: enabled ? new Date() : null,
    }) },
    oAuthApplication: { findFirst: vi.fn().mockResolvedValue({
      id: "app-1", tenantId: "t", name: "App", type: "Web",
      redirectUris: ["https://app.example.com/callback"], postLogoutRedirectUris: [],
      zitadelApplicationId: "remote-app", zitadelProjectId: "tenant-project",
      clientId: "client-1", clientSecretCiphertext: "encrypted",
      createdBy: "admin", updatedBy: "admin", createdAt: new Date(), updatedAt: new Date(),
    }) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      oAuthApplication: { create: vi.fn().mockResolvedValue({}) },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    })),
  };
  const zitadel = {
    provision: vi.fn().mockResolvedValue({
      applicationId: "remote-app", clientId: "client-1", clientSecret: "new-secret",
    }),
    delete: vi.fn(),
  };
  const service = new OAuthApplicationsService(
    prisma as unknown as PrismaService,
    { encrypt: vi.fn().mockReturnValue("encrypted") } as unknown as EncryptionService,
    zitadel as unknown as ZitadelOAuthApplicationService,
  );
  const dto = { name: "App", type: "Web" as const, redirectUris: ["https://app.example.com/callback"] };
  return { service, prisma, zitadel, dto };
}

describe("Tenant OAuth client provisioning", () => {
  it("never provisions tenant clients in the shared platform project by default", async () => {
    const f = fixture(false);
    await expect(f.service.create("t", f.dto, { id: "admin", displayName: "Admin" } as never))
      .rejects.toThrow("not activated or grants are stale");
    expect(f.zitadel.provision).not.toHaveBeenCalled();
  });

  it("provisions a verified tenant client only to that tenant's project", async () => {
    const f = fixture(true);
    const result = await f.service.create("t", f.dto, {
      id: "admin", displayName: "Admin",
    } as never);
    expect(f.zitadel.provision).toHaveBeenCalledWith({
      name: "App", type: "Web",
      redirectUris: ["https://app.example.com/callback"], postLogoutRedirectUris: [],
    }, "tenant-project");
    expect(result).toMatchObject({ zitadelProjectId: "tenant-project", clientId: "client-1" });
  });
});
