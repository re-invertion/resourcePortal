import { CustomRootDomainVerificationStatus, DnsStatus, DomainType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isDomainPublishable } from "./domain-publication";

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
