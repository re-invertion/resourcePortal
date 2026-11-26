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
    if (!clientId || clientId.length > 200 || clientId.trim() !== clientId) return false;
    const token = this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN");
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!token || !issuer?.startsWith("https://")) return false;

    let host: string;
    try {
      host = new URL(issuer).host;
    } catch {
      // Invalid issuer configuration must deny MCP client authorization, not
      // escape as an unclassified exception from the signed Action endpoint.
      return false;
    }
    const base = (this.config.get<string>("ZITADEL_INTERNAL_URL") ?? "http://zitadel:8080").replace(/\/$/, "");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-zitadel-instance-host": host,
      "x-zitadel-public-host": host,
    };
    const deadline = Date.now() + 6_000;
    const query = async (path: string, body: object) => {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const response = await fetch(`${base}${path}`, {
          signal: AbortSignal.timeout(Math.min(4_000, remaining)),
          method: "POST", redirect: "error", headers, body: JSON.stringify(body),
        });
        if (!response.ok) return null;
        // The Management API bearer must never be redirected to an arbitrary
        // endpoint. Bounds include bytes read after the response headers.
        const text = await readBoundedBody(response, 512_000);
        if (text === null) return null;
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
      } catch {
        // A timeout, connection reset, invalid JSON or redirect is an unknown
        // identity proof; never permit issuance from a partial observation.
        return null;
      }
    };

    // Search the DCR project by exact name. Do not mistake a partial or
    // ambiguous project listing for proof of a trusted OAuth client.
    const projects = await query("/management/v1/projects/_search", {
      query: { limit: 100 },
      queries: [{
        nameQuery: { name: "ZITADEL DCR", method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    });
    const projectList = projects?.result;
    const projectTotal = readTotalResult(projects?.details);
    // Never trust a first-page match if ListDetails is missing or announces
    // additional projects beyond that page. Real positive results include
    // totalResult; protobuf omits zero, which is a denial here.
    if (projectTotal !== 1 || !Array.isArray(projectList) || projectList.length !== 1) {
      return false;
    }
    const project: unknown = projectList[0];
    if (!isRecord(project) || project.name !== "ZITADEL DCR") return false;
    if (!isRecord(project) || typeof project.id !== "string" || !project.id) return false;

    // ZITADEL v4.19.5 ApplicationService V2 supports an authoritative exact
    // client-ID AND project-ID lookup. Never scan the shared DCR inventory:
    // unrelated registrations and churn must not consume this client's budget.
    // The limit of two makes ambiguous matches a denial, not a first-row win.
    const apps = await query("/zitadel.application.v2.ApplicationService/ListApplications", {
      pagination: { limit: 2 },
      filters: [
        { projectIdFilter: { projectId: project.id } },
        { clientIdFilter: { clientId } },
      ],
    });
    const appList = apps?.applications;
    if (readTotalResult(apps?.pagination) !== 1 ||
        !Array.isArray(appList) || appList.length !== 1) return false;
    const candidate: unknown = appList[0];
    if (!isRecord(candidate) || typeof candidate.applicationId !== "string" ||
        !candidate.applicationId || candidate.projectId !== project.id ||
        candidate.state !== "APPLICATION_STATE_ACTIVE" ||
        !isRecord(candidate.oidcConfiguration) ||
        candidate.oidcConfiguration.clientId !== clientId) return false;
    // Do not accept mixed redirect sets or stale/inactive client identities.
    const redirects = candidate.oidcConfiguration.redirectUris;
    return Array.isArray(redirects) && redirects.length > 0 &&
      redirects.every(isChatGptOAuthRedirect);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(advertised) || advertised > maxBytes) return null;
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let size = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // A transport-owned stream may never settle cancel(). The bounded
        // authorization decision must not wait for cancellation to finish.
        // Attach rejection handling so cleanup cannot emit an unhandled error.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/** A missing or malformed total is not evidence that the search is complete. */
function readTotalResult(details: unknown): number | null {
  if (!isRecord(details)) return null;
  const value = details.totalResult;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function isChatGptOAuthRedirect(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.search || url.hash ||
        !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return false;
    // ChatGPT's per-connector callback has exactly one opaque path segment.
    // Reject empty/nested/encoded paths and any URL suffix that might route
    // differently from the exact callback validated by ZITADEL.
    return url.pathname === "/connector_platform_oauth_redirect" ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname);
  } catch {
    return false;
  }
}
