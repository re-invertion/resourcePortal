import {
  ForbiddenException, Injectable, ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppConsumersService } from "./app-consumers.service";

type CallbackPayload = {
  function?: string;
  user?: { id?: string };
  application?: { client_id?: string };
};

/**
 * Fail-closed callback for an opt-in, separately certified ZITADEL Actions V2
 * preaccesstoken target. Never enable a global execution against a live issuer
 * until the exact-client authorization + refresh E2E and DB restore gates pass.
 */
@Injectable()
export class AppConsumerActionService {
  constructor(
    private readonly config: ConfigService,
    private readonly consumers: AppConsumersService,
  ) {}

  async authorize(
    raw: Buffer | undefined,
    signatureHeader: string | string[] | undefined,
  ): Promise<Record<string, never>> {
    if (this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") !== "true" ||
      this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") !== "true") {
      throw new ServiceUnavailableException("App Consumer authorization target disabled");
    }
    const signingKey = this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY");
    if (!signingKey || signingKey.length < 32) {
      throw new ServiceUnavailableException("App Consumer target signing key unavailable");
    }
    if (!raw || raw.length === 0 || raw.length > 1_000_000 ||
      typeof signatureHeader !== "string" ||
      !verifyActionSignature(raw, signatureHeader, signingKey)) {
      throw new UnauthorizedException("Invalid ZITADEL Action signature");
    }

    let payload: CallbackPayload;
    try {
      payload = JSON.parse(raw.toString("utf8")) as CallbackPayload;
    } catch {
      throw new ForbiddenException("Invalid Action payload");
    }
    // ZITADEL Actions V2 serializes the execution function as a namespaced
    // identifier, e.g. "function/preaccesstoken". The bare condition name is
    // used only in the management API. Require the exact signed webhook value.
    if (!payload || typeof payload !== "object" ||
      payload.function !== "function/preaccesstoken") {
      throw new ForbiddenException("Unsupported Action function");
    }
    const subject = payload.user?.id;
    const clientId = payload.application?.client_id;
    if (typeof subject !== "string" || !/^\d{1,64}$/.test(subject) ||
      typeof clientId !== "string" || !clientId.trim()) {
      throw new ForbiddenException("ZITADEL Action user or client identity missing");
    }

    const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "");
    if (!issuer?.startsWith("https://")) {
      throw new ServiceUnavailableException("Issuer not configured");
    }
    // Native RP is not a tenant OAuth application. Allow its regular/JIT
    // users, but deny a consumer account from acquiring RP-native tokens.
    // Check the signed subject in RP's DB; never trust a client name or email.
    if (clientId === this.config.get<string>("OIDC_CLIENT_ID")) {
      try {
        if (await this.consumers.mayIssueNativeRpToken(issuer, subject)) return {};
      } catch {
        // A DB outage must not fail open to a privileged RP OAuth client.
      }
      throw new ForbiddenException("RP native login denied");
    }

    try {
      if (await this.consumers.mayIssueClientToken(issuer, subject, clientId)) return {};
    } catch {
      // No user, grant or secret details in the denied response or HTTP logs.
      throw new ForbiddenException("OIDC client access denied");
    }
    throw new ForbiddenException("OIDC client access denied");
  }
}

export function verifyActionSignature(
  raw: Buffer,
  header: string,
  signingKey: string,
  now = Date.now(),
): boolean {
  const match = /^t=(\d{10}),v1=([0-9a-f]{64})$/i.exec(header.replace(/\s+/g, ""));
  if (!match || !signingKey) return false;
  const timestamp = match[1];
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac("sha256", signingKey)
    .update(timestamp + ".").update(raw).digest();
  const received = Buffer.from(match[2], "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}
