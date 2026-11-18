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
      result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
    })))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      result: [{ id: "dcr-app", oidcConfig: { clientId, redirectUris } }],
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

  it("paginates DCR apps instead of silently denying a client after the default first 100", async () => {
    const otherClients = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`, oidcConfig: { clientId: `other-client-${index}`, redirectUris: [] },
    }));
    const calls = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: "1" },
        result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: "101" }, result: otherClients,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: "101" },
        result: [{ id: "target", oidcConfig: {
          clientId: "registered-chatgpt-client",
          redirectUris: ["https://chatgpt.com/connector/oauth/unique-id"],
        } }],
      })));
    global.fetch = calls as typeof fetch;

    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(true);
    expect(calls).toHaveBeenCalledTimes(3);
    const projectRequest = calls.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse((projectRequest.body as string)) as unknown).toMatchObject({
      query: { limit: 100 },
      queries: [{ nameQuery: { name: "ZITADEL DCR", method: "TEXT_QUERY_METHOD_EQUALS" } }],
    });
    const secondPageRequest = calls.mock.calls[2]?.[1] as unknown as RequestInit;
    expect(JSON.parse((secondPageRequest.body as string)) as unknown).toEqual({
      query: { limit: 100, offset: 100 },
    });
  });

  it("fails closed for ambiguous DCR projects and truncated or malformed app pages", async () => {
    const project = { id: "dcr-project", name: "ZITADEL DCR" };
    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      details: { totalResult: 2 }, result: [project],
    }))) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [project] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        details: { totalResult: 201 },
        result: [{ id: "other", oidcConfig: { clientId: "different" } }],
      }))) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);

    const calls = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [project] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "one", oidcConfig: { clientId: "registered-chatgpt-client",
          redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] } },
          { id: "two", oidcConfig: { clientId: "registered-chatgpt-client",
            redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] } }],
      })));
    global.fetch = calls as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
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

  it("fails closed when ZITADEL app/project discovery fails or is unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("error", { status: 503 })) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).resolves.toBe(false);
    global.fetch = vi.fn().mockRejectedValue(new Error("network unavailable")) as typeof fetch;
    await expect(new McpDcrClientVerifierService(config)
      .isTrustedChatGptClient("registered-chatgpt-client")).rejects.toThrow("network unavailable");
  });
});
