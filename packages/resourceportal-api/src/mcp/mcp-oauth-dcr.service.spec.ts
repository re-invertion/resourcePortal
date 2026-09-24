import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpOAuthDcrService } from "./mcp-oauth-dcr.service";

const originalFetch = global.fetch;

function service() {
  return new McpOAuthDcrService({
    get: vi.fn((key: string) =>
      ({
        ZITADEL_INTERNAL_URL: "http://zitadel:8080",
        OIDC_ISSUER_URL: "https://auth.resource-portal.test",
        ZITADEL_MANAGEMENT_TOKEN: "management-token",
      })[key],
    ),
  } as unknown as ConfigService);
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("McpOAuthDcrService", () => {
  it("uses the v2 partial application update so JWT conversion preserves public-client OAuth settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_id: "client-1",
            registration_access_token: "registration-token",
            registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/client-1",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [{ id: "dcr-project", name: "ZITADEL DCR" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: [{ id: "app-1", oidcConfig: { clientId: "client-1" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const result = await service().register(
      {
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector/oauth/example"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      undefined,
    );

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://zitadel:8080/zitadel.application.v2.ApplicationService/UpdateApplication",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          applicationId: "app-1",
          projectId: "dcr-project",
          oidcConfiguration: {
            accessTokenType: "OIDC_TOKEN_TYPE_JWT",
          },
        }),
      }),
    );
    const managementOptions = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(managementOptions.headers).toMatchObject({
      "connect-protocol-version": "1",
      "x-zitadel-instance-host": "auth.resource-portal.test",
      "x-zitadel-public-host": "auth.resource-portal.test",
    });
    expect(managementOptions.headers).not.toHaveProperty("x-zitadel-orgid");
  });

  it("passes DCR validation errors through without management mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_client_metadata" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    const result = await service().register({}, undefined);

    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a just-created DCR client when the JWT compatibility update fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_id: "client-1",
            registration_access_token: "registration-token",
            registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/client-1",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [{ id: "dcr-project", name: "ZITADEL DCR" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: [{ id: "app-1", oidcConfig: { clientId: "client-1" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(service().register({}, undefined)).rejects.toThrow(
      "ZITADEL DCR compatibility update failed with HTTP 500",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://zitadel:8080/oauth/v2/register/client-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});