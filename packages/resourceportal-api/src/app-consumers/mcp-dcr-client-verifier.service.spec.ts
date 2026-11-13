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
  ])("rejects untrusted ChatGPT redirect %s", (uri) => {
    expect(isChatGptOAuthRedirect(uri)).toBe(false);
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
