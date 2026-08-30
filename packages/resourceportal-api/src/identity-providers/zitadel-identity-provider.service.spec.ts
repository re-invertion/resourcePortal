import { ConfigService } from "@nestjs/config";
import { IdentityProviderProtocol } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZitadelIdentityProviderService } from "./zitadel-identity-provider.service";

type RecordedRequest = {
  body?: Record<string, unknown>;
  method?: string;
  url: string;
};

function createConfig(values: Record<string, string | undefined>) {
  return {
    get: <T = string>(key: string) => values[key] as T | undefined,
  } as ConfigService;
}

function installFetch(responses: Array<{ body?: unknown; status?: number }>) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const response = responses.shift() ?? {};
      requests.push({
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
        method: init?.method,
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
      });
      return Promise.resolve(
        new Response(
          response.body === undefined ? null : JSON.stringify(response.body),
          {
            status: response.status ?? 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }),
  );
  return requests;
}

function service() {
  return new ZitadelIdentityProviderService(
    createConfig({
      OIDC_ISSUER_URL: "https://identity.example.com",
      ZITADEL_MANAGEMENT_TOKEN: "management-token",
      ZITADEL_ORGANIZATION_ID: "zitadel-org-1",
    }),
  );
}

describe("ZitadelIdentityProviderService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("provisions OIDC, enables allowExternalIdp and links the provider", async () => {
    const requests = installFetch([
      { body: { id: "zitadel-idp-1" } },
      {
        body: {
          isDefault: true,
          policy: {
            allowUsernamePassword: true,
            allowRegister: true,
            allowExternalIdp: false,
            forceMfa: false,
            passwordlessType: "PASSWORDLESS_TYPE_NOT_ALLOWED",
          },
        },
      },
      {},
      { body: { isDefault: false, policy: { allowExternalIdp: true } } },
      {},
    ]);

    await expect(
      service().provision({
        clientId: "client-1",
        clientSecret: "secret-1",
        enabled: true,
        issuer: "https://external.example.com",
        name: "External OIDC",
        protocol: IdentityProviderProtocol.OIDC,
        scopes: ["profile", "email"],
        usePkce: true,
      }),
    ).resolves.toBe("zitadel-idp-1");

    expect(requests).toMatchObject([
      {
        method: "POST",
        url: "https://identity.example.com/management/v1/idps/generic_oidc",
        body: {
          clientId: "client-1",
          clientSecret: "secret-1",
          issuer: "https://external.example.com",
          name: "External OIDC",
          scopes: ["openid", "profile", "email"],
          usePkce: true,
          providerOptions: {
            autoLinking: "AUTO_LINKING_OPTION_UNSPECIFIED",
          },
        },
      },
      {
        method: "GET",
        url: "https://identity.example.com/management/v1/policies/login",
      },
      {
        method: "POST",
        url: "https://identity.example.com/management/v1/policies/login",
        body: {
          allowUsernamePassword: true,
          allowRegister: true,
          allowExternalIdp: true,
          forceMfa: false,
          passwordlessType: "PASSWORDLESS_TYPE_NOT_ALLOWED",
        },
      },
      {
        method: "GET",
        url: "https://identity.example.com/management/v1/policies/login",
      },
      {
        method: "POST",
        url: "https://identity.example.com/management/v1/policies/login/idps",
        body: {
          idpId: "zitadel-idp-1",
          ownerType: "IDP_OWNER_TYPE_ORG",
        },
      },
    ]);
  });

  it("updates an existing custom login policy before enabling an IdP", async () => {
    const requests = installFetch([
      {
        body: {
          isDefault: false,
          policy: {
            allowUsernamePassword: false,
            allowRegister: false,
            allowExternalIdp: false,
            isDefault: false,
          },
        },
      },
      {},
      { body: { isDefault: false, policy: { allowExternalIdp: true } } },
      {},
    ]);

    await service().setEnabled("zitadel-idp-1", true);

    expect(requests).toMatchObject([
      {
        method: "GET",
        url: "https://identity.example.com/management/v1/policies/login",
      },
      {
        method: "PUT",
        url: "https://identity.example.com/management/v1/policies/login",
        body: {
          allowUsernamePassword: false,
          allowRegister: false,
          allowExternalIdp: true,
        },
      },
      {
        method: "GET",
        url: "https://identity.example.com/management/v1/policies/login",
      },
      {
        method: "POST",
        url: "https://identity.example.com/management/v1/policies/login/idps",
      },
    ]);
  });

  it("does not mutate an already enabled external login policy", async () => {
    const requests = installFetch([
      { body: { isDefault: false, policy: { allowExternalIdp: true } } },
      {},
    ]);

    await service().setEnabled("zitadel-idp-1", true);

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "GET",
        url: "https://identity.example.com/management/v1/policies/login",
      },
      {
        method: "POST",
        url: "https://identity.example.com/management/v1/policies/login/idps",
      },
    ]);
  });

  it("updates SAML metadata and removes the provider idempotently", async () => {
    const requests = installFetch([{}, { status: 404 }, {}]);
    const adapter = service();

    await adapter.update("zitadel-saml-1", {
      enabled: false,
      metadataUrl: "https://saml.example.com/metadata",
      name: "Enterprise SAML",
      protocol: IdentityProviderProtocol.SAML,
      scopes: [],
      usePkce: false,
    });
    await adapter.delete("zitadel-saml-1");

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "PUT",
        url: "https://identity.example.com/management/v1/idps/saml/zitadel-saml-1",
      },
      {
        method: "DELETE",
        url: "https://identity.example.com/management/v1/policies/login/idps/zitadel-saml-1",
      },
      {
        method: "DELETE",
        url: "https://identity.example.com/management/v1/idps/templates/zitadel-saml-1",
      },
    ]);
  });

  it("fails closed when the management token is missing", async () => {
    const adapter = new ZitadelIdentityProviderService(
      createConfig({
        OIDC_ISSUER_URL: "https://identity.example.com",
        ZITADEL_ORGANIZATION_ID: "zitadel-org-1",
      }),
    );
    const requests = installFetch([]);

    await expect(
      adapter.provision({
        clientId: "client-1",
        clientSecret: "secret-1",
        enabled: true,
        issuer: "https://external.example.com",
        name: "External OIDC",
        protocol: IdentityProviderProtocol.OIDC,
        scopes: ["openid"],
        usePkce: true,
      }),
    ).rejects.toThrow("ZITADEL_MANAGEMENT_TOKEN is required");
    expect(requests).toEqual([]);
  });

  it("removes a newly created provider when login-policy linking fails", async () => {
    const requests = installFetch([
      { body: { id: "zitadel-idp-1" } },
      { body: { isDefault: false, policy: { allowExternalIdp: true } } },
      { status: 500 },
      {},
    ]);

    await expect(
      service().provision({
        clientId: "client-1",
        clientSecret: "secret-1",
        enabled: true,
        issuer: "https://external.example.com",
        name: "External OIDC",
        protocol: IdentityProviderProtocol.OIDC,
        scopes: ["openid"],
        usePkce: true,
      }),
    ).rejects.toThrow(
      "ZITADEL identity provider request failed with HTTP 500",
    );

    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://identity.example.com/management/v1/idps/templates/zitadel-idp-1",
    });
  });

  it("fails when ZITADEL does not persist allowExternalIdp", async () => {
    const requests = installFetch([
      { body: { id: "zitadel-idp-1" } },
      {
        body: {
          isDefault: false,
          policy: { allowExternalIdp: false, isDefault: false },
        },
      },
      {},
      { body: { isDefault: false, policy: { allowExternalIdp: false } } },
      {},
    ]);

    await expect(
      service().provision({
        clientId: "client-1",
        clientSecret: "secret-1",
        enabled: true,
        issuer: "https://external.example.com",
        name: "External OIDC",
        protocol: IdentityProviderProtocol.OIDC,
        scopes: ["openid"],
        usePkce: true,
      }),
    ).rejects.toThrow(
      "ZITADEL login policy did not enable external identity providers",
    );

    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://identity.example.com/management/v1/idps/templates/zitadel-idp-1",
    });
  });
});
