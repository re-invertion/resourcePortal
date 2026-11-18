import { ConfigService } from "@nestjs/config";
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppConsumerActionService, verifyActionSignature } from "./app-consumer-action.service";

const secret = "q-3b8e92f4-zitadel-generated-action-target-signing-key";
function signed(input: object) {
  const raw = Buffer.from(JSON.stringify(input), "utf8");
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex");
  return { raw, header: `t=${timestamp},v1=${hmac}` };
}
function fixture(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
    RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
    RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: secret,
    OIDC_ISSUER_URL: "https://zitadel.example.test",
    OIDC_CLIENT_ID: "rp-native-client-id",
    OIDC_CLI_CLIENT_ID: "rp-cli-client-id",
    ...overrides,
  };
  const config = { get: vi.fn((key: string) => env[key]) } as unknown as ConfigService;
  const mayIssueLegacyClientToken = vi.fn().mockResolvedValue(false);
  const mayIssueNativeRpToken = vi.fn().mockResolvedValue(true);
  const mayIssueMcpDcrToken = vi.fn().mockResolvedValue(false);
  const mayIssueMcpUpstreamToken = vi.fn().mockResolvedValue(false);
  const isTrustedChatGptClient = vi.fn().mockResolvedValue(false);
  const svc = new AppConsumerActionService(
    config,
    { mayIssueLegacyClientToken, mayIssueNativeRpToken,
      mayIssueMcpDcrToken, mayIssueMcpUpstreamToken } as never,
    { isTrustedChatGptClient } as never,
  );
  return { svc, mayIssueLegacyClientToken, mayIssueNativeRpToken,
    mayIssueMcpDcrToken, mayIssueMcpUpstreamToken, isTrustedChatGptClient };
}
const client = { function: "function/preaccesstoken", user: { id: "12131" }, application: { client_id: "home-assistant" } };

describe("fail closed ZITADEL Actions V2 production entitlement target", () => {
  it("denies when disabled or signing secret absent", async () => {
    const payload = signed(client);
    await expect(fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "false" }).svc.authorize(payload.raw, payload.header))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(fixture({ RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: "" }).svc.authorize(payload.raw, payload.header))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("validates exact signed bytes and rejects forged, stale or missing signatures", async () => {
    const f = fixture(); const payload = signed(client);
    await expect(f.svc.authorize(payload.raw, "")).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.svc.authorize(Buffer.from(payload.raw.toString().replace("home-assistant","mypa")), payload.header))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyActionSignature(payload.raw, payload.header, secret)).toBe(true);
    expect(verifyActionSignature(payload.raw, payload.header, secret, Date.now() + 3600_000)).toBe(false);
    expect(f.mayIssueLegacyClientToken).not.toHaveBeenCalled();
  });
  it("denies missing subject, client ID, or unsupported function", async () => {
    for (const value of [
      { function: "function/preaccesstoken", user: {}, application: { client_id: "home-assistant" } },
      { function: "function/preaccesstoken", user: { id: "12131" }, application: {} },
      { ...client, function: "preaccesstoken" },
      { ...client, function: "function/preuserinfo" },
      { ...client, function: undefined },
    ]) {
      const { raw, header } = signed(value);
      await expect(fixture().svc.authorize(raw, header)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it("allows only exact verified issuer/subject/client grant and not unrelated clients", async () => {
    const f = fixture(); const payload = signed(client);
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueLegacyClientToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131", "home-assistant");
    f.mayIssueLegacyClientToken.mockResolvedValueOnce(true);
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({});
    await expect(f.svc.authorize(signed({ ...client, application: { client_id: "mypa" } }).raw,
      signed({ ...client, application: { client_id: "mypa" } }).header)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("retains existing OAuth and MCP DCR clients for non-consumers only", async () => {
    const f = fixture();
    const legacy = signed({ ...client, application: { client_id: "preexisting-mcp-dcr" } });
    f.mayIssueLegacyClientToken.mockResolvedValueOnce(true);
    expect(await f.svc.authorize(legacy.raw, legacy.header)).toEqual({});
    f.mayIssueLegacyClientToken.mockResolvedValueOnce(false);
    await expect(f.svc.authorize(legacy.raw, legacy.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueLegacyClientToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131", "preexisting-mcp-dcr");
  });

  it("links and refreshes an actually registered ChatGPT DCR only with current MCP entitlement", async () => {
    const f = fixture();
    const payload = signed({ ...client, application: { client_id: "chatgpt-dcr-123" } });
    f.isTrustedChatGptClient.mockResolvedValue(true);
    f.mayIssueMcpDcrToken.mockResolvedValue(true);
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({});
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({}); // refresh
    expect(f.mayIssueMcpDcrToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131");

    f.mayIssueMcpDcrToken.mockResolvedValue(false); // permission revoked before next refresh
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    f.isTrustedChatGptClient.mockResolvedValue(false);
    f.mayIssueMcpDcrToken.mockResolvedValue(true);
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    f.isTrustedChatGptClient.mockRejectedValue(new Error("ZITADEL unavailable"));
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("accepts only a persisted per-tenant MCP-only upstream client after signed user entitlement", async () => {
    const f = fixture({ RP_MCP_RESOURCE_OAUTH_ENABLED: "auto" });
    const payload = signed({
      ...client, application: { client_id: "340396026519785524" },
    });
    f.mayIssueMcpUpstreamToken.mockResolvedValueOnce(true);
    await expect(f.svc.authorize(payload.raw, payload.header)).resolves.toEqual({});
    expect(f.mayIssueMcpUpstreamToken).toHaveBeenCalledWith(
      "https://zitadel.example.test", "12131", "340396026519785524",
    );
    expect(f.mayIssueNativeRpToken).not.toHaveBeenCalled();
    expect(f.mayIssueMcpDcrToken).not.toHaveBeenCalled();

    // Role revoked / unknown issuer client: never inherit the global DCR grant.
    await expect(f.svc.authorize(payload.raw, payload.header))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.isTrustedChatGptClient).not.toHaveBeenCalled();
    f.mayIssueMcpUpstreamToken.mockRejectedValueOnce(Error("ZITADEL unavailable"));
    await expect(f.svc.authorize(payload.raw, payload.header))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("preserves explicitly identified RP-native login client without granting any tenant OAuth client", async () => {
    const f = fixture();
    const payload = signed({ ...client, application: { client_id: "rp-native-client-id" } });
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({});
    expect(f.mayIssueNativeRpToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131", "web");
    expect(f.mayIssueLegacyClientToken).not.toHaveBeenCalled();
  });

  it("allows RP CLI only through its own dedicated exact native-client entitlement", async () => {
    const f = fixture();
    const cli = signed({ ...client, application: { client_id: "rp-cli-client-id" } });
    expect(await f.svc.authorize(cli.raw, cli.header)).toEqual({});
    expect(f.mayIssueNativeRpToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131", "cli");
    expect(f.mayIssueLegacyClientToken).not.toHaveBeenCalled();
  });

  it("denies App Consumers on CLI and denies CLI on native identity lookup failure", async () => {
    const f = fixture();
    const cli = signed({ ...client, application: { client_id: "rp-cli-client-id" } });
    f.mayIssueNativeRpToken.mockResolvedValueOnce(false);
    await expect(f.svc.authorize(cli.raw, cli.header)).rejects.toBeInstanceOf(ForbiddenException);
    f.mayIssueNativeRpToken.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.svc.authorize(cli.raw, cli.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueLegacyClientToken).not.toHaveBeenCalled();
  });

  it("never recognizes empty, pending or unrelated OAuth client as native CLI", async () => {
    for (const override of ["", "bootstrap-pending"]) {
      const f = fixture({ OIDC_CLI_CLIENT_ID: override });
      const payload = signed({ ...client, application: { client_id: override || "unknown-client" } });
      await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.mayIssueNativeRpToken).not.toHaveBeenCalled();
    }
    const f = fixture();
    const other = signed({ ...client, application: { client_id: "unmanaged-external-client" } });
    await expect(f.svc.authorize(other.raw, other.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueNativeRpToken).not.toHaveBeenCalled();
  });

  it("blocks native RP access for App Consumer subjects and fails closed if DB is down", async () => {
    const f = fixture();
    const payload = signed({ ...client, application: { client_id: "rp-native-client-id" } });
    f.mayIssueNativeRpToken.mockResolvedValueOnce(false);
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    f.mayIssueNativeRpToken.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueLegacyClientToken).not.toHaveBeenCalled();
  });
});
