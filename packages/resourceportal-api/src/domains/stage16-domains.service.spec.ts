import { resolveTxt } from "node:dns/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ resolveTxt: vi.fn() }));

const implementationUrl = new URL("./stage16-domains.service.ts", import.meta.url);
const modulePath = "./stage16-domains.service";

const root = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  rootDomain: "example.test",
  verificationStatus: "Pending",
  verificationMethod: "DNS_TXT",
  verificationToken: "rp-verification-token",
  verificationCreatedAt: new Date("2026-08-31T12:00:00Z"),
  verifiedAt: null,
  createdBy: "33333333-3333-4333-8333-333333333333",
  updatedBy: "33333333-3333-4333-8333-333333333333",
  createdAt: new Date("2026-08-31T12:00:00Z"),
  updatedAt: new Date("2026-08-31T12:00:00Z"),
  domains: [],
};

const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "actor@example.com",
  displayName: "Actor",
  status: "Active",
};

function prisma() {
  const findFirst = vi.fn().mockResolvedValue(root);
  const update = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      ...root,
      verificationStatus: data.verificationStatus ?? root.verificationStatus,
      verifiedAt: data.verifiedAt ?? null,
      updatedBy: data.updatedBy ?? root.updatedBy,
    }),
  );
  return {
    customRootDomain: { findFirst, update },
  };
}

describe("Stage 16 custom root DNS verification", () => {
  it("classifies resolver transport failure as retryable without writing Failed", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      Stage16DomainsService: new (prisma: unknown, config: unknown) => {
        validateCustomRootDomain: (
          tenantId: string,
          customRootDomainId: string,
          actor: unknown,
        ) => Promise<unknown>;
      };
    };
    const db = prisma();
    vi.mocked(resolveTxt).mockRejectedValueOnce(
      Object.assign(new Error("resolver timed out"), { code: "ETIMEOUT" }),
    );
    const service = new imported.Stage16DomainsService(db, {});

    await expect(
      service.validateCustomRootDomain(root.tenantId, root.id, actor),
    ).rejects.toMatchObject({
      code: "DnsResolverUnavailable",
      retryable: true,
    });
    expect(db.customRootDomain.update).not.toHaveBeenCalled();
  });

  it("treats a completed negative DNS answer as a successful verification operation with Failed business state", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      Stage16DomainsService: new (prisma: unknown, config: unknown) => {
        validateCustomRootDomain: (
          tenantId: string,
          customRootDomainId: string,
          actor: unknown,
        ) => Promise<{ verificationStatus: string }>;
      };
    };
    const db = prisma();
    vi.mocked(resolveTxt).mockRejectedValueOnce(
      Object.assign(new Error("no txt record"), { code: "ENODATA" }),
    );
    const service = new imported.Stage16DomainsService(db, {});

    await expect(
      service.validateCustomRootDomain(root.tenantId, root.id, actor),
    ).resolves.toMatchObject({ verificationStatus: "Failed" });
    expect(db.customRootDomain.update).toHaveBeenCalledTimes(1);
  });

  it("marks a matching TXT token as Verified", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      Stage16DomainsService: new (prisma: unknown, config: unknown) => {
        validateCustomRootDomain: (
          tenantId: string,
          customRootDomainId: string,
          actor: unknown,
        ) => Promise<{ verificationStatus: string }>;
      };
    };
    const db = prisma();
    vi.mocked(resolveTxt).mockResolvedValueOnce([[root.verificationToken]]);
    const service = new imported.Stage16DomainsService(db, {});

    await expect(
      service.validateCustomRootDomain(root.tenantId, root.id, actor),
    ).resolves.toMatchObject({ verificationStatus: "Verified" });
  });
});
