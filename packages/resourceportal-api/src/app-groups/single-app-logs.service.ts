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

/** Mask OAuth callback/query credentials in tenant-facing container logs. */
function redactOAuthLogLine(line: string): string {
  return line
    .replace(
      /(\/(?:oauth2\/callback|api\/auth\/callback|api\/mcp\/oauth\/upstream\/callback|oauth\/v2\/authorize))\?[^\s"'<>]+/gi,
      "$1?[REDACTED]",
    )
    .replace(
      /((?:[?&]|&amp;|\\u0026)(?:code|state|session_state|id_token|access_token|refresh_token|code_verifier|client_secret)=)[^\s&#"'<>\\]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bAuthorization:\s*(?:Bearer|Basic)\s+)[^\s,"'\\]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:Cookie|Set-Cookie):\s*)[^\r\n]+/gi, "$1[REDACTED]");
}
