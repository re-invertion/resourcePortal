import { ConfigService } from "@nestjs/config";
import { CustomRootDomainVerificationStatus } from "@prisma/client";
import { vi, afterEach, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";

vi.mock("node:dns/promises", () => ({
  resolveTxt: vi.fn(),
}));

import { resolveTxt } from "node:dns/promises";
import { DomainsService } from "./domains.service";

const resolveTxtMock = vi.mocked(resolveTxt);
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const;

function root(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    rootDomain: "example.com",
    verificationStatus: CustomRootDomainVerificationStatus.Pending,
    verificationMethod: "DNS_TXT",
    verificationToken: "rp-domain-verification=abc123",
    verificationCreatedAt: now,
    verifiedAt: null,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    domains: [],
    ...overrides,
  };
}

function serviceFor(item = root()) {
  const prisma = {
    customRootDomain: {
      findFirst: vi.fn().mockResolvedValue(item),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...item, ...data, domains: item.domains }),
      ),
    },
  };
  const config = {
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  };
  return {
    prisma,
    service: new DomainsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    ),
  };
}

describe("DomainsService.validateCustomRootDomain", () => {
  afterEach(() => {
    resolveTxtMock.mockReset();
  });

  it("marks a root domain verified only when its exact TXT token exists", async () => {
    const item = root();
    const { service } = serviceFor(item);
    resolveTxtMock.mockResolvedValue([
      ["google-site-verification=other"],
      ["rp-domain-verification=", "abc123"],
    ]);

    const result = await service.validateCustomRootDomain(
      item.tenantId,
      item.id,
      actor as never,
    );

    expect(resolveTxtMock).toHaveBeenCalledWith("example.com");
    expect(result.verificationStatus).toBe(
      CustomRootDomainVerificationStatus.Verified,
    );
    expect(result.verifiedAt).toBeInstanceOf(Date);
  });

  it("rejects ownership when TXT records do not contain the verification token", async () => {
    const item = root();
    const { service } = serviceFor(item);
    resolveTxtMock.mockResolvedValue([["rp-domain-verification=wrong"]]);

    const result = await service.validateCustomRootDomain(
      item.tenantId,
      item.id,
      actor as never,
    );

    expect(result.verificationStatus).toBe(
      CustomRootDomainVerificationStatus.Failed,
    );
    expect(result.verifiedAt).toBeNull();
  });

  it("marks verification failed when DNS lookup fails", async () => {
    const item = root();
    const { service } = serviceFor(item);
    resolveTxtMock.mockRejectedValue(new Error("ENOTFOUND"));

    const result = await service.validateCustomRootDomain(
      item.tenantId,
      item.id,
      actor as never,
    );

    expect(result.verificationStatus).toBe(
      CustomRootDomainVerificationStatus.Failed,
    );
    expect(result.verifiedAt).toBeNull();
  });
});
