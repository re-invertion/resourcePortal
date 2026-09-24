import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  McpOAuthAuthorizationServerMetadataController,
  TenantMcpOAuthMetadataController,
} from "./tenant-mcp.controller";

const tenantId = "22222222-2222-4222-8222-222222222222";

function config() {
  return {
    get: vi.fn((key: string) => {
      if (key === "OIDC_ISSUER_URL") return "https://auth.resource-portal.test";
      if (key === "ZITADEL_PROJECT_ID") return "project-id";
      if (key === "ZITADEL_ORGANIZATION_ID") return "org-id";
      return undefined;
    }),
  };
}

describe("MCP OAuth metadata", () => {
  it("publishes tenant protected-resource metadata from the canonical MCP URL", () => {
    const controller = new TenantMcpOAuthMetadataController(config() as never);
    const request = {
      protocol: "http",
      headers: {
        host: "web.internal:5173",
        "x-forwarded-host": "resource-portal.test",
        "x-forwarded-proto": "https",
      },
    } as unknown as FastifyRequest;

    const metadata = controller.metadata(tenantId, request);
    expect(metadata).toMatchObject({
      resource: `https://resource-portal.test/api/tenants/${tenantId}/mcp`,
      authorization_servers: ["https://auth.resource-portal.test"],
    });
    expect(metadata.scopes_supported).toContain("openid");
    expect(metadata.scopes_supported).toContain("offline_access");
    expect(metadata.scopes_supported).toContain(
      "urn:zitadel:iam:org:project:id:project-id:aud",
    );
  });

  it("bridges ZITADEL OIDC discovery to RFC 8414 metadata required by MCP clients", async () => {
    const oidc = {
      getDiscovery: vi.fn().mockResolvedValue({
        issuer: "https://auth.resource-portal.test",
        authorizationEndpoint: "https://auth.resource-portal.test/oauth/v2/authorize",
        tokenEndpoint: "https://auth.resource-portal.test/oauth/v2/token",
        registrationEndpoint: "https://auth.resource-portal.test/oauth/v2/register",
        jwksUri: "https://auth.resource-portal.test/oauth/v2/keys",
        userInfoEndpoint: "https://auth.resource-portal.test/oidc/v1/userinfo",
        revocationEndpoint: "https://auth.resource-portal.test/oauth/v2/revoke",
        introspectionEndpoint: "https://auth.resource-portal.test/oauth/v2/introspect",
        scopesSupported: ["openid", "profile", "email", "offline_access"],
        responseTypesSupported: ["code"],
        responseModesSupported: ["query", "form_post"],
        grantTypesSupported: ["authorization_code", "refresh_token"],
        tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic"],
        codeChallengeMethodsSupported: ["S256"],
        authorizationResponseIssParameterSupported: false,
      }),
    };
    const controller = new McpOAuthAuthorizationServerMetadataController(
      oidc as never,
      config() as never,
    );

    const metadata = await controller.metadata();

    expect(metadata).toMatchObject({
      issuer: "https://auth.resource-portal.test",
      authorization_endpoint: "https://auth.resource-portal.test/oauth/v2/authorize",
      token_endpoint: "https://auth.resource-portal.test/oauth/v2/token",
      registration_endpoint: "https://auth.resource-portal.test/oauth/v2/register",
      userinfo_endpoint: "https://auth.resource-portal.test/oidc/v1/userinfo",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      authorization_response_iss_parameter_supported: false,
    });
    expect(metadata.scopes_supported).toContain("openid");
    expect(metadata.scopes_supported).toContain("offline_access");
    expect(metadata.scopes_supported).toContain(
      "urn:zitadel:iam:org:project:id:project-id:aud",
    );
    expect(metadata.scopes_supported).toContain("urn:zitadel:iam:org:id:org-id");
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
  });
});
