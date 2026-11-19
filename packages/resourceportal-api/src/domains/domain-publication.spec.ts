import { CustomRootDomainVerificationStatus, DnsStatus, DomainType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isDomainPublishable, domainPublicationDiagnostics } from "./domain-publication";

const tenantId = "tenant-a";
const verified = {
  tenantId, rootDomain: "example.com",
  verificationStatus: CustomRootDomainVerificationStatus.Verified,
};
const domain = {
  type: DomainType.Custom, tenantId, hostname: "app.example.com",
  dnsStatus: DnsStatus.Valid, customRootDomain: verified,
};
describe("custom domain ownership gate (#204)", () => {
  it("publishes verified tenant-owned subdomains", () => {
    expect(isDomainPublishable(domain, tenantId)).toBe(true);
  });
  it("denies legacy domains, unverified or transferred roots, and DNS-only CNAME claims", () => {
    const bad = [
      { ...domain, customRootDomain: null },
      { ...domain, customRootDomain: { ...verified, verificationStatus: CustomRootDomainVerificationStatus.Pending } },
      { ...domain, customRootDomain: { ...verified, tenantId: "tenant-b" } },
      { ...domain, hostname: "unrelated.example.net" },
      { ...domain, hostname: "example.com" },
      { ...domain, dnsStatus: DnsStatus.Invalid },
      { ...domain, tenantId: "tenant-b" },
    ];
    for (const candidate of bad) expect(isDomainPublishable(candidate, tenantId)).toBe(false);
  });
  it("permits RP-managed domains only if DNS is valid for the requesting tenant", () => {
    expect(isDomainPublishable({ ...domain, type: DomainType.Managed, customRootDomain: null }, tenantId)).toBe(true);
    expect(isDomainPublishable({ ...domain, type: DomainType.Managed, tenantId: "tenant-b" }, tenantId)).toBe(false);
  });
});

describe("ingress publication eligibility diagnostics (#394)", () => {
  it("distinguishes a legacy root-link blocker despite green DNS and TLS", () => {
    const result = domainPublicationDiagnostics({ ...domain, httpEndpointId: "endpoint", customRootDomain: null }, tenantId);
    expect(result).toEqual({ eligible: false, reason: "VerifiedRootLinkMissing" });
  });
  it("distinguishes missing endpoint, DNS mismatch, unverified root and eligible domain", () => {
    expect(domainPublicationDiagnostics({ ...domain, httpEndpointId: null }, tenantId).reason).toBe("NoHttpEndpoint");
    expect(domainPublicationDiagnostics({ ...domain, httpEndpointId: "endpoint", dnsStatus: DnsStatus.Invalid }, tenantId).reason).toBe("DnsNotValid");
    expect(domainPublicationDiagnostics({ ...domain, httpEndpointId: "endpoint", customRootDomain: { ...verified, verificationStatus: CustomRootDomainVerificationStatus.Pending } }, tenantId).reason).toBe("RootNotVerified");
    expect(domainPublicationDiagnostics({ ...domain, httpEndpointId: "endpoint" }, tenantId)).toEqual({ eligible: true, reason: null });
  });
});
