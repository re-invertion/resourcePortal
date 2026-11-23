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
  it("respects bounded operator-configured request timeouts", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_client_metadata" }), { status: 400 }),
    );
    global.fetch = fetchMock as typeof fetch;
    const config = { get: vi.fn((key: string) => ({
      ZITADEL_INTERNAL_URL: "http://zitadel:8080",
      OIDC_ISSUER_URL: "https://auth.resource-portal.test",
      ZITADEL_DCR_REQUEST_TIMEOUT_MS: "1250",
      ZITADEL_DCR_REGISTRATION_TIMEOUT_MS: "5000",
    })[key]) } as unknown as ConfigService;
    await new McpOAuthDcrService(config).register({});
    expect(timeout).toHaveBeenCalledWith(expect.any(Number));
    expect(timeout.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(1250);
  });

  it("aborts an actually stalled upstream DCR request within the configured bound", async () => {
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = options.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("request timed out", "TimeoutError")), { once: true });
    }));
    global.fetch = fetchMock as typeof fetch;
    const config = { get: vi.fn((key: string) => ({
      ZITADEL_INTERNAL_URL: "http://zitadel:8080",
      OIDC_ISSUER_URL: "https://auth.resource-portal.test",
      ZITADEL_DCR_REQUEST_TIMEOUT_MS: "500",
      ZITADEL_DCR_REGISTRATION_TIMEOUT_MS: "5000",
    })[key]) } as unknown as ConfigService;
    const started = Date.now();
    await expect(new McpOAuthDcrService(config).register({})).rejects.toThrow(
      "ZITADEL OAuth client registration may have been accepted",
    );
    expect(Date.now() - started).toBeLessThan(2500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid timeout configuration before any upstream request", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    const config = { get: vi.fn((key: string) => ({
      ZITADEL_INTERNAL_URL: "http://zitadel:8080",
      ZITADEL_DCR_REQUEST_TIMEOUT_MS: "never",
    })[key]) } as unknown as ConfigService;
    await expect(new McpOAuthDcrService(config).register({})).rejects.toThrow(
      "ZITADEL_DCR_REQUEST_TIMEOUT_MS must be a positive integer",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
            result: [
              {
                id: "app-1",
                oidcConfig: {
                  clientId: "client-1",
                  responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
                  grantTypes: [
                    "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
                    "OIDC_GRANT_TYPE_REFRESH_TOKEN",
                  ],
                },
              },
            ],
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
            responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
            grantTypes: [
              "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
              "OIDC_GRANT_TYPE_REFRESH_TOKEN",
            ],
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

  it("converts a newly registered DCR app on the second ZITADEL search page", async () => {
    const otherApps = Array.from({ length: 100 }, (_, index) => ({
      id: `another-app-${index}`,
      oidcConfig: { clientId: `another-client-${index}` },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        client_id: "client-on-page-two",
        registration_access_token: "registration-token",
        registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/client-on-page-two",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: 101 }, result: otherApps,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: 101 },
        result: [{ id: "app-on-page-two", oidcConfig: {
          clientId: "client-on-page-two",
          responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
          grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
        } }],
      })))
      .mockResolvedValueOnce(new Response("{}"));
    global.fetch = fetchMock as typeof fetch;

    await expect(service().register({ redirect_uris: ["https://chatgpt.com/connector/oauth/example"] }))
      .resolves.toMatchObject({ status: 201 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const options = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(JSON.parse((options.body as string)) as unknown).toEqual({ query: { limit: 100, offset: 100 } });
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      "http://zitadel:8080/zitadel.application.v2.ApplicationService/UpdateApplication",
    );
  });

  it("fails closed and rolls back when ZITADEL lists ambiguous DCR projects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        client_id: "client-1",
        registration_access_token: "registration-token",
        registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/client-1",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: 2 },
        result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(service().register({})).rejects.toThrow("DCR project search was ambiguous");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://zitadel:8080/oauth/v2/register/client-1",
    );
    const options = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse((options.body as string)) as unknown).toMatchObject({
      queries: [{ nameQuery: { name: "ZITADEL DCR" } }],
    });
  });

  it("retries an empty omitted ListApps result until the newly registered client is projected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        client_id: "eventual-client",
        registration_access_token: "registration-token",
        registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/eventual-client",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ details: { totalResult: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "eventual-app", oidcConfig: {
          clientId: "eventual-client",
          responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
          grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
        } }],
      })))
      .mockResolvedValueOnce(new Response("{}"));
    global.fetch = fetchMock as typeof fetch;
    await expect(service().register({})).resolves.toMatchObject({ status: 201 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not leak internal URLs or credentials when the upstream connection fails", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(
      new TypeError("connect failed to http://zitadel:8080 with token sensitive-secret"),
    );
    global.fetch = fetchMock as typeof fetch;
    let thrown: unknown;
    try {
      await service().register({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).toContain("ZITADEL OAuth client registration may have been accepted");
    expect(String(thrown)).not.toContain("sensitive-secret");
    expect(String(thrown)).not.toContain("http://zitadel:8080");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("redacts malformed management JSON and compensates a registered DCR client", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        client_id: "client-1",
        registration_access_token: "sensitive-registration-token",
        registration_client_uri: "https://auth.resource-portal.test/oauth/v2/register/client-1",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(
        '{"details":"secret-management-response", malformed', { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as typeof fetch;
    let failure: unknown;
    try { await service().register({}); } catch (error) {
      failure = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(JSON.stringify(failure)).toContain("ZITADEL DCR management response was invalid");
    expect(JSON.stringify(failure)).not.toContain("secret-management-response");
    expect(JSON.stringify(failure)).not.toContain("sensitive-registration-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      "http://zitadel:8080/oauth/v2/register/client-1",
      expect.objectContaining({ method: "DELETE" }));
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
            result: [
              {
                id: "app-1",
                oidcConfig: {
                  clientId: "client-1",
                  responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
                  grantTypes: [
                    "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
                    "OIDC_GRANT_TYPE_REFRESH_TOKEN",
                  ],
                },
              },
            ],
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
describe("MCP DCR bounded response and deadline (#213)", () => {
  it("identifies uncertain upstream registration after an oversized 201 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("A".repeat(1_048_577), { status: 201 }));
    global.fetch = fetchMock as typeof fetch;
    let failure: unknown;
    try { await service().register({}); } catch (error) {
      failure = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(failure).toMatchObject({ code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(JSON.stringify(failure)).not.toContain("A".repeat(100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed successful DCR response as requiring manual reconciliation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      "not-json-with-secret-registration-credential", { status: 201 },
    ));
    global.fetch = fetchMock as typeof fetch;
    let failure: unknown;
    try { await service().register({}); } catch (error) {
      failure = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(failure).toMatchObject({ code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(JSON.stringify(failure)).not.toContain("secret-registration-credential");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("provides AbortSignals on the registration and management requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ client_id: "c" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ id: "p", name: "ZITADEL DCR" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ id: "app", oidcConfig: {
        clientId: "c", responseTypes: ["OIDC_RESPONSE_TYPE_CODE"], grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
      } }] })))
      .mockResolvedValueOnce(new Response("{}"));
    global.fetch = fetchMock as typeof fetch;
    await service().register({});
    for (const call of fetchMock.mock.calls) {
      const options = call[1] as RequestInit | undefined;
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});


describe("DCR partial registration compensation (#213)", () => {
  function registration(uri = "https://auth.resource-portal.test/oauth/v2/register/client-1") {
    return new Response(JSON.stringify({
      client_id: "client-1",
      registration_access_token: "sensitive-registration-token",
      registration_client_uri: uri,
    }), { status: 201 });
  }

  async function partialRegistrationResponse(fetchMock: ReturnType<typeof vi.fn>) {
    global.fetch = fetchMock as typeof fetch;
    try {
      await service().register({});
      throw new Error("Expected DCR partial-registration failure");
    } catch (cause) {
      const response = cause && typeof cause === "object" && "getResponse" in cause
        ? (cause as { getResponse: () => unknown }).getResponse() : cause;
      expect(response).toMatchObject({
        code: "DCR_PARTIAL_REGISTRATION",
        clientId: "client-1",
      });
      expect(JSON.stringify(response)).not.toContain("sensitive-registration-token");
      expect(JSON.stringify(response)).not.toContain("management-token");
      expect(JSON.stringify(response)).toContain("manual reconciliation");
    }
  }

  it("reports the partial client when rollback DELETE returns HTTP 503", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(registration())
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await partialRegistrationResponse(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("http://zitadel:8080/oauth/v2/register/client-1");
    expect((fetchMock.mock.calls[2][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("reports partial state when upstream DELETE fails with a network error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(registration())
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    await partialRegistrationResponse(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not send registration bearer to a rollback URI outside the DCR endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(registration("https://auth.resource-portal.test/management/v1/projects/_search"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await partialRegistrationResponse(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the original compatibility error after confirmed rollback success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(registration())
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as typeof fetch;
    await expect(service().register({})).rejects.toThrow("compatibility update failed with HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
