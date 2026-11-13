import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Only actual ZITADEL DCR applications whose OAuth callback is controlled by
 * ChatGPT are eligible for the tenant MCP-specific token policy. No arbitrary
 * client_id, client_name or application-provided metadata is trusted.
 */
@Injectable()
export class McpDcrClientVerifierService {
  constructor(private readonly config: ConfigService) {}

  async isTrustedChatGptClient(clientId: string): Promise<boolean> {
    if (!clientId || clientId.length > 256) return false;
    const token = this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN");
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!token || !issuer?.startsWith("https://")) return false;

    const host = new URL(issuer).host;
    const base = (this.config.get<string>("ZITADEL_INTERNAL_URL") ?? "http://zitadel:8080").replace(/\/$/, "");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-zitadel-instance-host": host,
      "x-zitadel-public-host": host,
    };
    const query = async (path: string, body: object) => {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(4000),
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      // A bounded response and fail-closed JSON parsing; never expose credentials.
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > 512_000) return null;
      const text = await response.text();
      if (text.length > 512_000) return null;
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    };

    const projects = await query("/management/v1/projects/_search", {});
    const projectList = projects?.result;
    if (!Array.isArray(projectList)) return false;
    const project = (projectList as unknown[]).find((entry) =>
      isRecord(entry) && entry.name === "ZITADEL DCR" && typeof entry.id === "string");
    if (!isRecord(project) || typeof project.id !== "string") return false;

    const applications = await query(
      `/management/v1/projects/${encodeURIComponent(project.id)}/apps/_search`,
      {},
    );
    const appList = applications?.result;
    if (!Array.isArray(appList)) return false;
    const app = (appList as unknown[]).find((entry) => {
      if (!isRecord(entry) || !isRecord(entry.oidcConfig)) return false;
      return entry.oidcConfig.clientId === clientId;
    });
    if (!isRecord(app) || !isRecord(app.oidcConfig)) return false;
    const redirects = app.oidcConfig.redirectUris;
    // Do not accept mixed redirect sets: another callback would allow
    // redirecting the code to an untrusted party despite the trusted entry.
    return Array.isArray(redirects) && redirects.length > 0 &&
      redirects.every(isChatGptOAuthRedirect);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isChatGptOAuthRedirect(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.search || url.hash ||
        !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return false;
    return url.pathname === "/connector_platform_oauth_redirect" ||
      url.pathname.startsWith("/connector/oauth/");
  } catch {
    return false;
  }
}
