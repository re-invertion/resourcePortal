import { ConfigService } from "@nestjs/config";
import {
  CertificateStatus,
  CustomRootDomainVerificationStatus,
  DnsStatus,
  DomainType,
} from "@prisma/client";
import { vi, afterEach, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { ManagedDnsService } from "../platform-dns/managed-dns.service";
import type { CloudflareTenantOauthService } from "../platform-dns/cloudflare-tenant-oauth.service";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  resolveCname: vi.fn(),
  resolveTxt: vi.fn(),
}));

import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import { DomainsService } from "./domains.service";

const resolve4Mock = vi.mocked(resolve4);
const resolve6Mock = vi.mocked(resolve6);
const resolveCnameMock = vi.mocked(resolveCname);
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
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
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

type DomainFixture = ReturnType<typeof domainRecord>;
type DomainCreateCall = {
  data: Record<string, unknown>;
};
type DomainUpdateCall = {
  data: Record<string, unknown>;
};
type CustomRootCreateCall = {
  data: {
    rootDomain: string;
    verificationMethod: string;
    verificationToken: string;
  };
};

function domainServiceFor(input: {
  endpointProtocolMode?: string;
  existingDomain?: DomainFixture;
  customRoot?: ReturnType<typeof root> | null;
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
      update: vi.fn().mockResolvedValue(existingDomain),
    },
    appGroup: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    customRootDomain: {
      findFirst: vi.fn().mockResolvedValue(input.customRoot ?? null),
      update: vi.fn().mockResolvedValue(input.customRoot ?? null),
    },
    domain: {
      findFirst: vi.fn().mockResolvedValue(existingDomain),
    },
    httpEndpoint: {
      findFirst: vi.fn().mockResolvedValue({
        id: existingDomain.httpEndpointId,
        protocolMode: endpointProtocolMode,
        singleApp: { appGroupId: existingDomain.httpEndpoint?.singleApp?.appGroupId ?? "77777777-7777-4777-8777-777777777777" },
      }),
    },
    $transaction: vi
      .fn()
      .mockImplementation(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
  };
  const config = {
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  };

  const managedDns = {
    provisionManagedDomain: vi.fn().mockResolvedValue({ created: false }),
    deleteManagedDomain: vi.fn().mockResolvedValue({ deleted: 1 }),
    managedDomainExists: vi.fn().mockResolvedValue(true),
    getDomainTargetHostname: vi.fn().mockReturnValue("apps.resource-portal.local"),
    getTenantCapabilities: vi.fn().mockResolvedValue({ managedDomains: { enabled: true, provider: "Cloudflare", baseDomain: "apps.resource-portal.local" } }),
  };
  return {
    prisma,
    tx,
    managedDns,
    service: new DomainsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      managedDns as unknown as ManagedDnsService,
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

    const call = tx.domain.create.mock.calls[0]?.[0] as DomainCreateCall;
    expect(call.data).toMatchObject({
      tlsEnabled: false,
      certificateStatus: CertificateStatus.Pending,
      certificateIssuer: null,
      certificateExpiresAt: null,
    });
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

    const call = tx.domain.update.mock.calls[0]?.[0] as DomainUpdateCall;
    expect(call.data).toMatchObject({
      httpEndpointId: null,
      tlsEnabled: false,
      certificateStatus: CertificateStatus.Pending,
      certificateIssuer: null,
      certificateExpiresAt: null,
    });
  });
});

describe("DomainsService managed Cloudflare DNS lifecycle", () => {
  it("provisions managed DNS before persisting a Managed domain", async () => {
    const { service, managedDns, tx } = domainServiceFor({ endpointProtocolMode: "HTTP" });

    await service.createDomain(
      "33333333-3333-4333-8333-333333333333",
      { type: DomainType.Managed, prefix: "app" },
      actor,
    );

    expect(managedDns.provisionManagedDomain).toHaveBeenCalledWith(
      "app.apps.resource-portal.local",
    );
    expect(tx.domain.create).toHaveBeenCalled();
  });

  it("removes a newly-created Cloudflare record when database persistence fails", async () => {
    const { service, managedDns, prisma } = domainServiceFor({ endpointProtocolMode: "HTTP" });
    managedDns.provisionManagedDomain.mockResolvedValue({ created: true });
    prisma.$transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      service.createDomain(
        "33333333-3333-4333-8333-333333333333",
        { type: DomainType.Managed, prefix: "app" },
        actor,
      ),
    ).rejects.toThrow("database unavailable");

    expect(managedDns.deleteManagedDomain).toHaveBeenCalledWith(
      "app.apps.resource-portal.local",
    );
  });

  it("marks Managed DNS invalid when the ResourcePortal-owned Cloudflare record is absent", async () => {
    const { service, managedDns, prisma } = domainServiceFor({ endpointProtocolMode: "HTTP" });
    managedDns.managedDomainExists.mockResolvedValue(false);
    prisma.domain.update = vi.fn().mockImplementation(({ data }: DomainUpdateCall) =>
      Promise.resolve(domainRecord({ ...data })),
    );

    const result = await service.validateDomain(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      actor,
    );

    expect(result.dnsStatus).toBe(DnsStatus.Invalid);
    expect(managedDns.managedDomainExists).toHaveBeenCalledWith(
      "app.apps.resource-portal.local",
    );
  });
});


describe("DomainsService tenant Cloudflare root-domain verification", () => {
  it("creates a verification TXT through the authorized account and marks the root verified", async () => {
    const created = root({
      verificationMethod: "CLOUDFLARE_OAUTH",
      verificationToken: "rp-domain-verification=generated",
    });
    const customRootDomain = {
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...created, ...data, domains: [] }),
      ),
    };
    const prisma = { customRootDomain };
    const config = { get: vi.fn((_key: string, defaultValue: unknown) => defaultValue) };
    const cloudflare = { ensureVerificationTxt: vi.fn().mockResolvedValue({ created: true }) };
    const service = new DomainsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      undefined,
      cloudflare as unknown as CloudflareTenantOauthService,
    );

    const result = await service.createCloudflareCustomRootDomain(
      created.tenantId,
      { zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rootDomain: "Example.COM" },
      actor,
    );

    const createCall = customRootDomain.create.mock.calls[0]?.[0] as CustomRootCreateCall;
    const createData = createCall.data;
    expect(createData.rootDomain).toBe("example.com");
    expect(createData.verificationMethod).toBe("CLOUDFLARE_OAUTH");
    expect(String(createData.verificationToken)).toMatch(/^rp-domain-verification=[a-f0-9]{48}$/);
    expect(cloudflare.ensureVerificationTxt).toHaveBeenCalledWith({
      tenantId: created.tenantId,
      userId: actor.id,
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rootDomain: "example.com",
      verificationToken: createData.verificationToken,
    });
    expect(result.verificationStatus).toBe(CustomRootDomainVerificationStatus.Verified);
    expect(result.verifiedAt).toBeInstanceOf(Date);
  });
});


describe("DomainsService Cloudflare OAuth custom DNS lifecycle", () => {
  function oauthFixture() {
    const customRoot = root({
      verificationStatus: CustomRootDomainVerificationStatus.Verified,
      verificationMethod: "CLOUDFLARE_OAUTH",
      createdBy: actor.id,
    });
    const existing = domainRecord({
      type: DomainType.Custom,
      prefix: null,
      customRootDomainId: customRoot.id,
      subdomain: "app",
      hostname: "app.example.com",
      dnsStatus: DnsStatus.Valid,
      httpEndpointId: null,
      httpEndpoint: null,
      customRootDomain: customRoot,
    });
    const tx = {
      domain: {
        create: vi.fn().mockResolvedValue(existing),
        delete: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(existing),
      },
      appGroup: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      customRootDomain: {
        findFirst: vi.fn().mockResolvedValue(customRoot),
      },
      domain: {
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(({ data }: DomainUpdateCall) =>
          Promise.resolve({ ...existing, ...data }),
        ),
      },
      httpEndpoint: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
        ),
    };
    const config = {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    };
    const cloudflare = {
      ensureManagedCustomDomain: vi.fn().mockResolvedValue({ created: true }),
      deleteManagedCustomDomain: vi.fn().mockResolvedValue({ deleted: 1 }),
      managedCustomDomainExists: vi.fn().mockResolvedValue(true),
    };
    const service = new DomainsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      undefined,
      cloudflare as unknown as CloudflareTenantOauthService,
    );
    return { service, prisma, tx, cloudflare, customRoot, existing };
  }

  it("provisions an RP-owned CNAME before persisting a Cloudflare OAuth custom domain", async () => {
    const f = oauthFixture();

    const result = await f.service.createDomain(
      f.existing.tenantId,
      {
        type: DomainType.Custom,
        customRootDomainId: f.customRoot.id,
        subdomain: "app",
      },
      actor,
    );

    expect(f.cloudflare.ensureManagedCustomDomain).toHaveBeenCalledWith({
      tenantId: f.existing.tenantId,
      userId: actor.id,
      hostname: "app.example.com",
    });
    const createCall = f.tx.domain.create.mock.calls[0]?.[0] as DomainCreateCall;
    expect(createCall.data.dnsStatus).toBe(DnsStatus.Valid);
    expect(result.dnsStatus).toBe(DnsStatus.Valid);
  });

  it("removes only the RP-owned custom-domain record when deleting the domain", async () => {
    const f = oauthFixture();

    await expect(
      f.service.deleteDomain(f.existing.tenantId, f.existing.id, actor),
    ).resolves.toEqual({ deleted: true });

    expect(f.cloudflare.deleteManagedCustomDomain).toHaveBeenCalledWith({
      tenantId: f.existing.tenantId,
      userId: actor.id,
      hostname: "app.example.com",
    });
    expect(f.tx.domain.delete).toHaveBeenCalledWith({
      where: { id: f.existing.id },
    });
  });

  it("checks the actual RP-owned Cloudflare record when validating the domain", async () => {
    const f = oauthFixture();
    f.cloudflare.managedCustomDomainExists.mockResolvedValue(false);

    const result = await f.service.validateDomain(
      f.existing.tenantId,
      f.existing.id,
      actor,
    );

    expect(f.cloudflare.managedCustomDomainExists).toHaveBeenCalledWith({
      tenantId: f.existing.tenantId,
      userId: actor.id,
      hostname: "app.example.com",
    });
    expect(result.dnsStatus).toBe(DnsStatus.Invalid);
  });
});

describe("DomainsService manual custom DNS validation", () => {
  afterEach(() => {
    resolveCnameMock.mockReset();
    resolve4Mock.mockReset();
    resolve6Mock.mockReset();
  });

  function fixture(hostname = "missing.example.net") {
    const existing = domainRecord({
      type: DomainType.Custom,
      prefix: null,
      customRootDomainId: null,
      subdomain: null,
      hostname,
      dnsStatus: DnsStatus.Pending,
      httpEndpointId: null,
      httpEndpoint: null,
      customRootDomain: null,
    });
    const prisma = {
      domain: {
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(({ data }: DomainUpdateCall) =>
          Promise.resolve({ ...existing, ...data }),
        ),
      },
    };
    const config = {
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === "RESOURCEPORTAL_PUBLIC_HOSTNAME"
          ? "resource-portal.pl"
          : defaultValue,
      ),
    };
    return {
      existing,
      service: new DomainsService(
        prisma as unknown as PrismaService,
        config as unknown as ConfigService,
      ),
    };
  }

  it("does not report Valid when a custom hostname does not point at ResourcePortal", async () => {
    const f = fixture();
    resolveCnameMock.mockRejectedValue(new Error("no cname"));
    resolve4Mock.mockImplementation((host: string) => Promise.resolve(
      host === "missing.example.net" ? ["203.0.113.10"] : ["198.51.100.20"],
    ));
    resolve6Mock.mockResolvedValue([]);

    const result = await f.service.validateDomain(
      f.existing.tenantId,
      f.existing.id,
      actor,
    );

    expect(result.dnsStatus).toBe(DnsStatus.Invalid);
  });

  it("rejects an unowned legacy custom hostname even when its CNAME targets ResourcePortal", async () => {
    const f = fixture("app.example.net");
    resolveCnameMock.mockResolvedValue(["resource-portal.pl."]);

    const result = await f.service.validateDomain(
      f.existing.tenantId,
      f.existing.id,
      actor,
    );

    expect(resolveCnameMock).not.toHaveBeenCalled();
    expect(result.dnsStatus).toBe(DnsStatus.Invalid);
  });
});

describe("DomainsService custom hostname ownership enforcement (#204)", () => {
  it("rejects unverified bare hostname creation before touching the database", async () => {
    const { service, tx } = domainServiceFor({});
    await expect(service.createDomain(
      "33333333-3333-4333-8333-333333333333",
      { type: DomainType.Custom, hostname: "victim.example.org" },
      actor,
    )).rejects.toThrow("verified customRootDomainId");
    expect(tx.domain.create).not.toHaveBeenCalled();
  });
});


describe("#394 safe legacy custom-domain root linking", () => {
  const legacy = () => domainRecord({
    type: DomainType.Custom,
    hostname: "photos.example.com",
    subdomain: "photos",
    customRootDomainId: null,
    customRootDomain: null,
  });
  const verifiedRoot = () => root({ verificationStatus: CustomRootDomainVerificationStatus.Verified });

  it("links only a verified tenant-owned root without resetting DNS, TLS, certificate or endpoint", async () => {
    const existingDomain = legacy();
    const targetRoot = verifiedRoot();
    const { service, prisma, tx } = domainServiceFor({ existingDomain, customRoot: targetRoot, endpointProtocolMode: "HTTPS" });
    await service.updateDomain(existingDomain.tenantId, existingDomain.id, { customRootDomainId: targetRoot.id }, actor);
    expect(prisma.customRootDomain.findFirst).toHaveBeenCalledWith({
      where: { id: targetRoot.id, tenantId: existingDomain.tenantId },
      include: { domains: true },
    });
    const call = tx.domain.update.mock.calls[0]?.[0] as DomainUpdateCall;
    expect(call.data).toMatchObject({ customRootDomainId: targetRoot.id, updatedBy: actor.id });
    expect(call.data.httpEndpointId).toBeUndefined();
    expect(call.data.certificateStatus).toBeUndefined();
    expect(call.data.certificateIssuer).toBeUndefined();
    expect(call.data.dnsStatus).toBeUndefined();
    expect(call.data.hostname).toBeUndefined();
    expect(tx.appGroup.update).toHaveBeenCalled();
  });

  it("does not clear TLS/certificate metadata when linking a legacy unassigned or HTTP-only domain", async () => {
    const targetRoot = verifiedRoot();
    for (const unassigned of [true, false]) {
      const existingDomain = legacy();
      if (unassigned) {
        existingDomain.httpEndpointId = null;
        (existingDomain as unknown as { httpEndpoint: null }).httpEndpoint = null;
      }
      const { service, tx } = domainServiceFor({
        existingDomain, customRoot: targetRoot, endpointProtocolMode: "HTTP",
      });
      await service.updateDomain(existingDomain.tenantId, existingDomain.id, { customRootDomainId: targetRoot.id }, actor);
      const call = tx.domain.update.mock.calls[0]?.[0] as DomainUpdateCall;
      expect(call.data.customRootDomainId).toBe(targetRoot.id);
      expect(call.data.httpEndpointId).toBeUndefined();
      expect(call.data.tlsEnabled).toBeUndefined();
      expect(call.data.certificateStatus).toBeUndefined();
      expect(call.data.certificateIssuer).toBeUndefined();
      expect(call.data.certificateExpiresAt).toBeUndefined();
    }
  });

  it("rejects missing tenant root and unverified or mismatching root without writing", async () => {
    const existingDomain = legacy();
    for (const targetRoot of [null, root(), root({rootDomain: "another.example.org", verificationStatus: CustomRootDomainVerificationStatus.Verified})]) {
      const { service, tx, prisma } = domainServiceFor({ existingDomain, customRoot: targetRoot });
      await expect(service.updateDomain(existingDomain.tenantId, existingDomain.id, {
        customRootDomainId: verifiedRoot().id,
      }, actor)).rejects.toThrow();
      expect(prisma.customRootDomain.findFirst).toHaveBeenCalledWith({
        where: { id: verifiedRoot().id, tenantId: existingDomain.tenantId }, include: { domains: true },
      });
      expect(tx.domain.update).not.toHaveBeenCalled();
    }
  });

  it("rejects managed domains, already linked custom domains and clearing root IDs", async () => {
    for (const existingDomain of [domainRecord(), legacy()]) {
      const first = (existingDomain.type === DomainType.Managed
        ? existingDomain : { ...existingDomain, customRootDomainId: verifiedRoot().id, customRootDomain: verifiedRoot() }) as DomainFixture;
      const { service, tx } = domainServiceFor({ existingDomain: first });
      await expect(service.updateDomain(first.tenantId, first.id, { customRootDomainId: verifiedRoot().id }, actor)).rejects.toThrow("LegacyCustomRootLinkOnly");
      expect(tx.domain.update).not.toHaveBeenCalled();
    }
    const current = legacy();
    const { service, tx } = domainServiceFor({ existingDomain: current });
    await expect(service.updateDomain(current.tenantId, current.id, { customRootDomainId: null as unknown as string }, actor)).rejects.toThrow("LegacyCustomRootLinkOnly");
    expect(tx.domain.update).not.toHaveBeenCalled();
  });
});

describe("#394 tenant-scoped read-only DNS diagnostics", () => {
  afterEach(() => { resolveCnameMock.mockReset(); resolve4Mock.mockReset(); resolve6Mock.mockReset(); });
  const custom = () => domainRecord({
    type: DomainType.Custom, hostname: "photos.example.com", subdomain: "photos",
    customRootDomainId: root().id,
    customRootDomain: root({ verificationStatus: CustomRootDomainVerificationStatus.Verified }),
  });
  it("reports matching CNAME target and actual evidence without changing DNS state", async () => {
    resolveCnameMock.mockResolvedValue(["apps.resource-portal.local."]);
    resolve4Mock.mockRejectedValue(Object.assign(new Error("missing"), {code: "ENODATA"}));
    resolve6Mock.mockRejectedValue(Object.assign(new Error("missing"), {code: "ENODATA"}));
    const { service, prisma } = domainServiceFor({ existingDomain: custom() });
    const result = await service.getDnsDiagnostics(custom().tenantId, custom().id);
    expect(result.status).toBe("Matches");
    expect(result.expected).toEqual({ type: "CNAME", target: "apps.resource-portal.local" });
    expect(result.observed.cname).toEqual(["apps.resource-portal.local"]);
    expect(prisma.domain.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: custom().id, tenantId: custom().tenantId } }));
  });
  it("shows expected-vs-observed record mismatch instead of implying route reachability", async () => {
    resolveCnameMock.mockResolvedValue(["wrong.example.net"]);
    resolve4Mock.mockResolvedValue([]); resolve6Mock.mockResolvedValue([]);
    const { service } = domainServiceFor({ existingDomain: custom() });
    const result = await service.getDnsDiagnostics(custom().tenantId, custom().id);
    expect(result.status).toBe("Mismatch");
    expect(result.observed.cname).toEqual(["wrong.example.net"]);
    expect(result.recommendation).toContain("CNAME photos.example.com to apps.resource-portal.local");
  });
  it("reports resolver failure separately from a mismatch", async () => {
    resolveCnameMock.mockRejectedValue(new Error("resolver timeout"));
    resolve4Mock.mockRejectedValue(new Error("resolver timeout"));
    resolve6Mock.mockRejectedValue(new Error("resolver timeout"));
    const { service } = domainServiceFor({ existingDomain: custom() });
    const result = await service.getDnsDiagnostics(custom().tenantId, custom().id);
    expect(result.status).toBe("Unavailable");
    expect(result.recommendation).toContain("DNS lookup failed");
  });
  it("reports flattened A/AAAA DNS as unavailable if target address lookups time out", async () => {
    resolveCnameMock.mockRejectedValue(Object.assign(new Error("no CNAME"), { code: "ENODATA" }));
    resolve4Mock.mockImplementation(async (hostname: string) => {
      if (hostname === "apps.resource-portal.local") throw new Error("target resolver timeout");
      return ["192.0.2.11"];
    });
    resolve6Mock.mockRejectedValue(Object.assign(new Error("no AAAA"), { code: "ENODATA" }));
    const { service } = domainServiceFor({ existingDomain: custom() });
    const result = await service.getDnsDiagnostics(custom().tenantId, custom().id);
    expect(result.status).toBe("Unavailable");
    expect(result.observed.a).toEqual(["192.0.2.11"]);
    expect(result.recommendation).toContain("DNS lookup failed");
  });

  it("preserves direct CNAME matches even when target A/AAAA lookups fail", async () => {
    resolveCnameMock.mockResolvedValue(["apps.resource-portal.local."]);
    resolve4Mock.mockRejectedValue(new Error("target resolver timeout"));
    resolve6Mock.mockRejectedValue(new Error("target resolver timeout"));
    const { service } = domainServiceFor({ existingDomain: custom() });
    expect((await service.getDnsDiagnostics(custom().tenantId, custom().id)).status).toBe("Matches");
  });

  it("never probes DNS for a custom domain with unverified root", async () => {
    const existing = custom();existing.customRootDomain = root();
    const { service } = domainServiceFor({ existingDomain: existing });
    const result = await service.getDnsDiagnostics(existing.tenantId, existing.id);
    expect(result.status).toBe("OwnershipUnverified");
    expect(resolveCnameMock).not.toHaveBeenCalled();
    expect(resolve4Mock).not.toHaveBeenCalled();
  });
});
