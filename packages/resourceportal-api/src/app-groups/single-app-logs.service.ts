import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";

/** Bounded, tenant-scoped Docker service logs. Never accepts a service name from the caller. */
@Injectable()
export class SingleAppLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(tenantId: string, appGroupId: string, singleAppId: string) {
    const singleApp = await this.prisma.singleApp.findFirst({
      where: { id: singleAppId, appGroupId, appGroup: { tenantId } },
      select: { name: true },
    });
    if (!singleApp) throw new NotFoundException("Application not found");

    const service = `rp_${appGroupId.replaceAll("-", "_")}_${singleApp.name.replaceAll("-", "_")}`;
    const token = this.config.get<string>("INTERNAL_WORKER_TOKEN");
    if (!token) throw new ServiceUnavailableException("Container logs are currently unavailable");
    const workerOrigin = this.config.get<string>("INTERNAL_LOG_WORKER_URL") ??
      (process.env.NODE_ENV === "production" ? "http://worker:3101" : "http://127.0.0.1:3101");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${workerOrigin}/internal/single-app-logs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify({ service }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Worker log request failed");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("lines" in result) ||
          !Array.isArray(result.lines) || !result.lines.every((line) => typeof line === "string")) {
        throw new Error("Invalid worker response");
      }
      // Ingress/OAuth2 proxies commonly log the FULL callback URL, including
      // one-time codes and state (#498). Redact before returning worker logs
      // over the UI or MCP; never assume tenant log-read implies access to
      // OAuth credentials. Retain timestamps, paths and statuses for RCA.
      const safeLines = result.lines.map((line) => redactOAuthLogLine(line));
      return { lines: safeLines.join("\n").slice(-65536).split("\n").filter(Boolean), serviceAvailable: true };
    } catch {
      throw new ServiceUnavailableException("Container logs are currently unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Mask structured OAuth fields and credential-bearing text before tenant log access.
 * Arbitrary application logs are NOT guaranteed secret-free. Unparseable
 * credential-bearing lines are suppressed rather than attempting to guess
 * boundaries of an opaque token, JSON fragment or multiline header.
 */
const redacted = "[REDACTED]";
const sensitiveKeys = new Set([
  "authorization", "proxyauthorization", "cookie", "setcookie", "headers",
  "requestheaders", "responseheaders", "accesstoken", "refreshtoken", "idtoken",
  "registrationaccesstoken", "registrationtoken", "devicecode", "usercode",
  "codeverifier", "clientsecret", "authorizationcode", "code", "state",
  "sessionstate", "sessiontoken", "nonce", "codechallenge", "password",
  "recoverycode", "recoverycodes", "totpsecret", "token", "secret",
]);
const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const sensitiveKey = (key: string) => sensitiveKeys.has(normalizeKey(key));
// Match field assignments after unescaping only for detection. Never emit a
// decoded diagnostic which might reveal credentials not present in the input.
const fieldAssignment = /(?:^|[^a-z0-9])(?:["']?)(authorization|proxy[-_ ]?authorization|(?:set[-_ ]?)?cookie|(?:request[-_ ]?|response[-_ ]?)?headers|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|registration[-_ ]?(?:access[-_ ]?)?token|device[-_ ]?code|user[-_ ]?code|code[-_ ]?verifier|client[-_ ]?secret|authorization[-_ ]?code|code|state|session[-_ ]?(?:state|token)|nonce|code[-_ ]?challenge|password|recovery[-_ ]?codes?|totp[-_ ]?secret|token|secret)["']?\s*[:=]\s*/gi;

function redactOAuthLogLine(line: string, depth = 0): string {
  if (depth > 12 || line.length > 65536) return redacted;
  // Docker commonly prefixes JSON with a timestamp. Preserve only a sanitized
  // prefix and JSON object; recursively inspect nested/escaped JSON strings.
  const trimmed = line.trim();
  const jsonStart = trimmed.search(/[[{]/);
  if (jsonStart >= 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(jsonStart));
      const prefix = trimmed.slice(0, jsonStart).trimEnd();
      return (prefix ? redactText(prefix) + " " : "") +
        JSON.stringify(redactValue(parsed, depth + 1));
    } catch {
      // Malformed or partial structured data must use the fail-closed text path.
    }
  }
  return redactText(line);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 12) return redacted;
  if (typeof value === "string") return redactOAuthLogLine(value, depth + 1);
  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && sensitiveKey(value[0])) return redacted;
    return value.map(entry => redactValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value);
    // Structured header/field entries often use {"name":"Authorization",
    // "value":"..."}, rather than using the header as the object key.
    if (fields.some(([key, entry]) =>
      ["name", "key", "header", "field"].includes(normalizeKey(key)) &&
      typeof entry === "string" && sensitiveKey(entry))) return redacted;
    return Object.fromEntries(fields.map(([key, entry]) => [
      key, sensitiveKey(key) ? redacted : redactValue(entry, depth + 1),
    ]));
  }
  return value;
}

function redactText(line: string): string {
  const cleaned = line
    .replace(
      /(\/(?:oauth2\/callback|api\/auth\/callback|api\/mcp\/oauth\/upstream\/callback|oauth\/v2\/authorize))\?[^\s"'<>]+/gi,
      "$1?[REDACTED]",
    )
    .replace(
      /((?:[?&]|&amp;|\\u0026)(?:code|state|session_state|id_token|access_token|refresh_token|code_verifier|client_secret|device_code|user_code|registration_access_token|registration_token|nonce|code_challenge|session_token)=)[^\s&#"'<>\\]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\b(?:Proxy-)?Authorization:\s*(?:Bearer|Basic)\s+)[^\s,"'\\]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:Cookie|Set-Cookie):\s*)[^\r\n]+/gi, "$1[REDACTED]");
  // Permit the explicitly masked ordinary query/header forms only. For
  // escaped/encoded keys, ambiguous assignments, or header fragments, redact
  // the whole diagnostic. Don't use a single regex to guess JSON boundaries.
  let decoded = cleaned;
  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/\\u([a-f0-9]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\(["'\\/])/g, "$1")
      .replace(/%([a-f0-9]{2})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  for (const match of decoded.matchAll(fieldAssignment)) {
    const tail = decoded.slice((match.index ?? 0) + match[0].length);
    if (!/^(?:(?:Bearer|Basic)\s+)?\[REDACTED\](?:$|[\s&#,"'<>\\}\]])/i.test(tail)) return redacted;
  }
  // Credentials embedded as free-form Bearer/Basic header values are unsafe.
  if (/\b(?:Bearer|Basic)\s+(?!\[REDACTED\])\S+/i.test(decoded)) return redacted;
  return cleaned;
}
