import { ConfigService } from "@nestjs/config";
import {
  CertificateStatus,
  CustomRootDomainVerificationStatus,
  DnsStatus,
  DomainType,
} from "@prisma/client";
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

function domainRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "44444444-4444-4444-8444-444444444444",
    tenantId: "33333333-3333-4333-8333-333333333333",
    type: DomainType.Managed,
    prefix: "app",
    customRootDomainId: null,
    subdomain: "app",
    hostname: "app.apps.resource-portal.local",
    dnsStatus: DnsStatus.Valid,
    tlsEnabled: true,
    certificateStatus: CertificateStatus.Active,
    certificateIssuer: "R12",
    certificateExpiresAt: new Date("2026-11-30T12:00:00.000Z"),
    httpEndpointId: "55555555-5555-4555-8555-555555555555",
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    customRootDomain: null,
    httpEndpoint: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "public",
      containerPort: 8080,
      protocolMode: "HTTPS",
      singleApp: {
        id: "66666666-6666-4666-8666-666666666666",
        name: "web",
        appGroupId: "77777777-7777-4777-8777-777777777777",
      },
    },
    ...overrides,
  };
}

function domainServiceFor(input: {
  endpointProtocolMode?: string;
  existingDomain?: ReturnType<typeof domainRecord>;
}) {
  const endpointProtocolMode = input.endpointProtocolMode ?? "HTTP";
  const existingDomain = input.existingDomain ?? domainRecord();
  const createdDomain = domainRecord({
    tlsEnabled: endpointProtocolMode !== "HTTP",
    certificateStatus: CertificateStatus.Pending,
    certificateIssuer: null,
    certificateExpiresAt: null,
    httpEndpoint: {
      ...existingDomain.httpEndpoint,
      protocolMode: endpointProtocolMode,
    },
  });
  const tx = {
    domain: {
      create: vi.fn().mockResolvedValue(createdDomain),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          ...existingDomain,
          ...data,
          httpEndpointId:
            data.httpEndpointId === undefined
              ? existingDomain.httpEndpointId
              : data.httpEndpointId,
          httpEndpoint:
            data.httpEndpointId === null ? null : existingDomain.httpEndpoint,
        }),
      ),
    },
    appGroup: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    domain: {
      findFirst: vi.fn().mockResolvedValue(existingDomain),
    },
    httpEndpoint: {
      findFirst: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: existingDomain.httpEndpointId,
          protocolMode: endpointProtocolMode,
          singleApp: { appGroupId: existingDomain.httpEndpoint.singleApp.appGroupId },
        }),
      ),
    },
    $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
  };
  const config = {
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  };

  return {
    prisma,
    tx,
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
      actor,
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
      actor,
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
      actor,
    );

    expect(result.verificationStatus).toBe(
      CustomRootDomainVerificationStatus.Failed,
    );
    expect(result.verifiedAt).toBeNull();
  });
});

describe("DomainsService TLS persistence", () => {
  it("derives tlsEnabled=false from an assigned HTTP endpoint even when dto requests TLS", async () => {
    const { service, tx } = domainServiceFor({ endpointProtocolMode: "HTTP" });

    await service.createDomain(
      "33333333-3333-4333-8333-333333333333",
      {
        type: DomainType.Managed,
        prefix: "app",
        httpEndpointId: "55555555-5555-4555-8555-555555555555",
        tlsEnabled: true,
      },
      actor,
    );

    expect(tx.domain.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tlsEnabled: false,
          certificateStatus: CertificateStatus.Pending,
          certificateIssuer: null,
          certificateExpiresAt: null,
        }),
      }),
    );
  });

  it("clears TLS certificate state immediately when a domain is detached", async () => {
    const existingDomain = domainRecord();
    const { service, tx } = domainServiceFor({
      endpointProtocolMode: "HTTPS",
      existingDomain,
    });

    await service.updateDomain(
      existingDomain.tenantId,
      existingDomain.id,
      { httpEndpointId: null },
      actor,
    );

    expect(tx.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          httpEndpointId: null,
          tlsEnabled: false,
          certificateStatus: CertificateStatus.Pending,
          certificateIssuer: null,
          certificateExpiresAt: null,
        }),
      }),
    );
  });
});
