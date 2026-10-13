import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

const values: Record<string, string> = {
  OIDC_ISSUER_URL: "https://auth.example.com",
  ZITADEL_MANAGEMENT_URL: "https://api.example.com",
  ZITADEL_MANAGEMENT_TOKEN: "test-secret",
  ZITADEL_ORGANIZATION_ID: "global-org",
};
const service = () => new ZitadelTenantProjectService({
  get: (key: string) => values[key],
} as ConfigService);

afterEach(() => vi.unstubAllGlobals());

describe("ZITADEL tenant OIDC project security", () => {
  it("creates a per-tenant project with per-user role checks enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "123456789" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().createProject("tenant-a")).resolves.toBe("123456789");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/management/v1/projects");
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: "rp-tenant-tenant-a",
      projectRoleCheck: true,
      hasProjectCheck: true,
      projectRoleAssertion: true,
    });
    expect(init.headers).toMatchObject({ "x-zitadel-orgid": "global-org" });
  });

  it("recovers the exact pre-existing project after interrupted provisioning", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "123", name: "rp-tenant-tenant-a" }],
        details: { totalResult: "1" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project: { id: "123", projectRoleCheck: true, hasProjectCheck: true },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().findExistingProjectForTenant("tenant-a")).resolves.toBe("123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/projects/_search");
  });

  it("refuses ambiguous project ownership instead of creating duplicates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      details: { totalResult: 2 },
      result: [
        { id: "123", name: "rp-tenant-tenant-a" },
        { id: "124", name: "rp-tenant-tenant-a" },
      ],
    }), { status: 200 })));
    await expect(service().findExistingProjectForTenant("tenant-a"))
      .rejects.toThrow("Ambiguous existing ZITADEL tenant project");
  });

  it("rejects projects with role checks disabled instead of silently enabling SSO", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      project: { id: "5", projectRoleCheck: false, hasProjectCheck: true },
    }), { status: 200 })));
    await expect(service().readProject("5")).rejects.toThrow(
      "security checks are not enabled",
    );
  });

  it("creates a role assignment only for the given project and user", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      userGrantId: "grant-1",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().assignMember("zitadel-user", "project-7")).resolves.toBe("grant-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/zitadel-user/grants");
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: "project-7", roleKeys: ["rp.tenant.member"],
    });
  });

  it("fails closed on provider errors without leaking tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response('{"error":"secret"}', { status: 401 }),
    ));
    await expect(service().createProject("t")).rejects.toThrow("HTTP 401");
  });

  it("uses the actual shared issuer, never fabricates per-tenant issuer", () => {
    expect(service().issuer).toBe("https://auth.example.com");
  });
  it("checks HTTPS issuer, PKCE discovery and signing JWKS before automatic activation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: "https://auth.example.com",
        jwks_uri: "https://auth.example.com/oauth/v2/keys",
        authorization_endpoint: "https://auth.example.com/oauth/v2/authorize",
        token_endpoint: "https://auth.example.com/oauth/v2/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        keys: [{ kid: "signing-1", kty: "RSA", use: "sig", alg: "RS256" }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().verifyIssuerSecurity()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map((call: [string]) => call[0])).toEqual([
      "https://auth.example.com/.well-known/openid-configuration",
      "https://auth.example.com/oauth/v2/keys",
    ]);
  });

  it("refuses untrusted JWKS origins without making a credential-leaking request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: "https://auth.example.com",
      jwks_uri: "https://malicious.example/keys",
      authorization_endpoint: "https://auth.example.com/oauth/v2/authorize",
      token_endpoint: "https://auth.example.com/oauth/v2/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().verifyIssuerSecurity()).rejects.toThrow("issuer or PKCE metadata is invalid");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cross-checks existing ZITADEL grants against the intended tenant project", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      userGrant: { projectId: "project-7", roleKeys: ["rp.tenant.member"] },
    }), { status: 200 }))));
    await expect(service().verifyMemberGrant("user-1", "grant-1", "project-7"))
      .resolves.toBeUndefined();
    await expect(service().verifyMemberGrant("user-1", "grant-1", "wrong-project"))
      .rejects.toThrow("does not match this tenant");
  });
});
