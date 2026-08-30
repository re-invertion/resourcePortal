import { describe, expect, it } from "vitest";
import { mapDomain } from "./domains.view";

function domain(protocolMode?: string) {
  const now = new Date("2026-08-30T18:30:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    type: "Managed",
    prefix: "app",
    customRootDomainId: null,
    subdomain: "app",
    hostname: "app.example.com",
    dnsStatus: "Valid",
    tlsEnabled: true,
    certificateStatus: "Active",
    certificateIssuer: "LetsEncrypt",
    certificateExpiresAt: new Date("2026-11-30T00:00:00.000Z"),
    httpEndpointId: protocolMode
      ? "33333333-3333-4333-8333-333333333333"
      : null,
    httpEndpoint: protocolMode
      ? {
          id: "33333333-3333-4333-8333-333333333333",
          name: "public",
          containerPort: 8080,
          protocolMode,
          singleApp: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "web",
            appGroupId: "55555555-5555-4555-8555-555555555555",
          },
        }
      : null,
    createdBy: "66666666-6666-4666-8666-666666666666",
    updatedBy: "66666666-6666-4666-8666-666666666666",
    createdAt: now,
    updatedAt: now,
  } as unknown as Parameters<typeof mapDomain>[0];
}

describe("mapDomain TLS semantics", () => {
  it("reports TLS disabled and clears stale certificate metadata for HTTP", () => {
    const result = mapDomain(domain("HTTP"));

    expect(result.tlsEnabled).toBe(false);
    expect(result.certificateStatus).toBe("Pending");
    expect(result.certificateExpiresAt).toBeNull();
  });

  it("reports TLS enabled for every TLS-requiring protocol mode", () => {
    expect(mapDomain(domain("HTTPS")).tlsEnabled).toBe(true);
    expect(mapDomain(domain("HTTP_AND_HTTPS")).tlsEnabled).toBe(true);
    expect(mapDomain(domain("HTTP_REDIRECT_TO_HTTPS")).tlsEnabled).toBe(true);
  });

  it("reports TLS disabled and clears stale certificate metadata when unassigned", () => {
    const result = mapDomain(domain());

    expect(result.tlsEnabled).toBe(false);
    expect(result.certificateStatus).toBe("Pending");
    expect(result.certificateExpiresAt).toBeNull();
  });
});
