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
    ...overrides,
  };
  const config = { get: vi.fn((key: string) => env[key]) } as unknown as ConfigService;
  const mayIssueClientToken = vi.fn().mockResolvedValue(false);
  const mayIssueNativeRpToken = vi.fn().mockResolvedValue(true);
  const svc = new AppConsumerActionService(config, { mayIssueClientToken, mayIssueNativeRpToken } as never);
  return { svc, mayIssueClientToken, mayIssueNativeRpToken };
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
    expect(f.mayIssueClientToken).not.toHaveBeenCalled();
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
    expect(f.mayIssueClientToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131", "home-assistant");
    f.mayIssueClientToken.mockResolvedValueOnce(true);
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({});
    await expect(f.svc.authorize(signed({ ...client, application: { client_id: "mypa" } }).raw,
      signed({ ...client, application: { client_id: "mypa" } }).header)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("preserves explicitly identified RP-native login client without granting any tenant OAuth client", async () => {
    const f = fixture();
    const payload = signed({ ...client, application: { client_id: "rp-native-client-id" } });
    expect(await f.svc.authorize(payload.raw, payload.header)).toEqual({});
    expect(f.mayIssueNativeRpToken).toHaveBeenCalledWith("https://zitadel.example.test", "12131");
    expect(f.mayIssueClientToken).not.toHaveBeenCalled();
  });

  it("blocks native RP access for App Consumer subjects and fails closed if DB is down", async () => {
    const f = fixture();
    const payload = signed({ ...client, application: { client_id: "rp-native-client-id" } });
    f.mayIssueNativeRpToken.mockResolvedValueOnce(false);
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    f.mayIssueNativeRpToken.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.svc.authorize(payload.raw, payload.header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.mayIssueClientToken).not.toHaveBeenCalled();
  });
});
