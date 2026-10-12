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
});
