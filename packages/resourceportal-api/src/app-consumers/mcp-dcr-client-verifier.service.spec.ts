import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isChatGptOAuthRedirect,
  McpDcrClientVerifierService,
} from "./mcp-dcr-client-verifier.service";

const originalFetch = global.fetch;
const config = {
  get: vi.fn((name: string) => ({
    ZITADEL_MANAGEMENT_TOKEN: "management-token",
    ZITADEL_INTERNAL_URL: "http://zitadel:8080",
    OIDC_ISSUER_URL: "https://auth.example.test",
  })[name as "ZITADEL_MANAGEMENT_TOKEN" | "ZITADEL_INTERNAL_URL" | "OIDC_ISSUER_URL"]),
} as unknown as ConfigService;

function mockDcrClient(redirectUris: unknown, clientId = "registered-chatgpt-client") {
  const calls = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      details: { totalResult: "1" },
      result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
    })))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      pagination: { totalResult: "1" },
      applications: [{ applicationId: "dcr-app", projectId: "dcr-project",
        state: "APPLICATION_STATE_ACTIVE", oidcConfiguration: { clientId, redirectUris } }],
    })));
  global.fetch = calls as typeof fetch;
  return calls;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ChatGPT MCP DCR issuance proof (#442)", () => {
  it("accepts only the exact ZITADEL-registered DCR client with ChatGPT-controlled callbacks", async () => {
    const calls = mockDcrClient(["https://chatgpt.com/connector_platform_oauth_redirect"]);
    const service = new McpDcrClientVerifierService(config);
    await expect(service.isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(true);
    const call = calls.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("http://zitadel:8080/management/v1/projects/_search");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers).toMatchObject({
      "x-zitadel-instance-host": "auth.example.test",
      authorization: "Bearer management-token",
    });
  });

  it("denies spoofed client IDs and mixed or attacker-controlled callback URIs", async () => {
    mockDcrClient(["https://chatgpt.com/connector/oauth/example"], "different-id");
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("unregistered-id")).resolves.toBe(false);

    mockDcrClient([
      "https://chatgpt.com/connector/oauth/example",
      "https://attacker.example.test/callback",
    ]);
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
  });

  it.each([
    "https://chatgpt.com.evil.test/connector/oauth/example",
    "http://chatgpt.com/connector/oauth/example",
    "https://chatgpt.com:444/connector/oauth/example",
    "https://chatgpt.com@evil.test/connector/oauth/example",
    "https://chatgpt.com/other/oauth/callback",
    "https://chatgpt.com/connector/oauth/example#fragment",
    "https://chatgpt.com/connector/oauth/example?next=evil",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/a/b",
    "https://chatgpt.com/connector/oauth/%2f",
    "https://chatgpt.com/connector/oauth/%2E%2E",
    "https://chatgpt.com/connector/oauth/callback%2Fother",
  ])("rejects untrusted ChatGPT redirect %s", (uri) => {
    expect(isChatGptOAuthRedirect(uri)).toBe(false);
  });

  it("uses a constant-size authoritative lookup independent of unrelated inventory growth", async () => {
    const calls = mockDcrClient(["https://chatgpt.com/connector/oauth/unique-id"]);
    const service = new McpDcrClientVerifierService(config);
    await expect(service.isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(true);
    expect(calls).toHaveBeenCalledTimes(2);
    const [url, req] = calls.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("http://zitadel:8080/zitadel.application.v2.ApplicationService/ListApplications");
    expect(req.headers).toMatchObject({ "Connect-Protocol-Version": "1" });
    expect(JSON.parse(req.body as string) as unknown).toEqual({
      pagination: { limit: 2 },
      filters: [
        { projectIdFilter: { projectId: "dcr-project" } },
        { clientIdFilter: { clientId: "registered-chatgpt-client" } },
      ],
    });
    // Another request must recheck the provider, not cache a revoked client.
    calls.mockResolvedValueOnce(Response.json({
      details: { totalResult: "1" }, result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
    })).mockResolvedValueOnce(Response.json({ pagination: { totalResult: "0" } }));
    await expect(service.isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("unrelated inventory growth and churn cannot consume the exact-client lookup budget", async () => {
    let globalInventorySize = 100;
    let active = true;
    const clientId = "registered-chatgpt-client";
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      const body: unknown = JSON.parse(init.body as string);
      if (url.endsWith("/projects/_search")) return Promise.resolve(Response.json({
        details: { totalResult: 1 }, result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
      }));
      if (url.endsWith("/apps/_search")) return Promise.resolve(Response.json({
        details: { totalResult: globalInventorySize }, result: [],
      }));
      expect(body).toEqual({ pagination: { limit: 2 }, filters: [
        { projectIdFilter: { projectId: "dcr-project" } }, { clientIdFilter: { clientId } },
      ] });
      return Promise.resolve(Response.json({ pagination: { totalResult: 1 }, applications: [{
        applicationId: "target", projectId: "dcr-project",
        state: active ? "APPLICATION_STATE_ACTIVE" : "APPLICATION_STATE_INACTIVE",
        oidcConfiguration: { clientId, redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] },
      }] }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new McpDcrClientVerifierService(config);
    for (const size of [100, 2_001, 50_000, 17]) {
      globalInventorySize = size;
      await expect(service.isTrustedChatGptClient(clientId)).resolves.toBe(true);
    }
    active = false;
    await expect(service.isTrustedChatGptClient(clientId)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/apps/_search"))).toBe(false);
  });

  it("fails closed for ambiguous projects, malformed exact matches, duplicates and inactive clients", async () => {
    const project = { id: "dcr-project", name: "ZITADEL DCR" };
    const candidate = {
      applicationId: "target", projectId: "dcr-project", state: "APPLICATION_STATE_ACTIVE",
      oidcConfiguration: { clientId: "registered-chatgpt-client",
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] },
    };
    global.fetch = vi.fn().mockResolvedValueOnce(Response.json({
      details: { totalResult: 2 }, result: [project],
    })) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    const invalid = [
      { pagination: { totalResult: 2 }, applications: [candidate] },
      { pagination: { totalResult: 1 }, applications: [candidate, candidate] },
      { applications: [candidate] },
      { pagination: { totalResult: true }, applications: [candidate] },
      { pagination: { totalResult: "1e0" }, applications: [candidate] },
      { pagination: { totalResult: 1 }, applications: [] },
      { pagination: { totalResult: 1 }, applications: [{ ...candidate, state: "APPLICATION_STATE_INACTIVE" }] },
      { pagination: { totalResult: 1 }, applications: [{ ...candidate, projectId: "foreign" }] },
      { pagination: { totalResult: 1 }, applications: [{ ...candidate, oidcConfiguration: { ...candidate.oidcConfiguration, clientId: "foreign" } }] },
      { pagination: { totalResult: 1 }, applications: [{ ...candidate, applicationId: "" }] },
    ];
    for (const result of invalid) {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(Response.json({ details: { totalResult: 1 }, result: [project] }))
        .mockResolvedValueOnce(Response.json(result)) as typeof fetch;
      await expect(new McpDcrClientVerifierService(config)
        .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    }
  });

  it("rejects Management redirects before forwarding the admin bearer", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://attacker.example.test/" } }),
    ) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    const calls = vi.mocked(global.fetch);
    expect((calls.mock.calls[0]?.[1] as RequestInit).redirect).toBe("error");
  });

  it("rejects a response that exceeds the bounded streaming limit", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("x".repeat(512_001), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a syntactically invalid HTTPS issuer before any bearer transport", async () => {
    const env: Record<string, string> = {
      ZITADEL_MANAGEMENT_TOKEN: "management-token",
      ZITADEL_INTERNAL_URL: "http://zitadel:8080",
      OIDC_ISSUER_URL: "https://",
    };
    const invalid = {
      get: vi.fn((name: string) => env[name]),
    } as unknown as ConfigService;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(new McpDcrClientVerifierService(invalid)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies an oversized streaming response even if transport cancellation never settles", async () => {
    let cancelCalled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512_001));
      },
      cancel() {
        cancelCalled = true;
        // Model a transport that never acknowledges cancellation.
        return new Promise<void>(() => undefined);
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(oversized, {
      status: 200, headers: { "content-type": "application/json" },
    }));
    global.fetch = fetchMock as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    expect(cancelCalled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when ZITADEL app/project discovery fails or is unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("error", { status: 503 })) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    global.fetch = vi.fn().mockRejectedValue(new Error("network unavailable")) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
  });
});
