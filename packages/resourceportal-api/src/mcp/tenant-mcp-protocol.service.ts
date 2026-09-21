import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";
import { AuthenticatedUser } from "../auth/types";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

const modernProtocolVersion = "2026-07-28";
const legacyProtocolVersion = "2025-11-25";
const supportedLegacyVersions = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const supportedProtocolVersions = [
  modernProtocolVersion,
  legacyProtocolVersion,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const serverInfo = {
  name: "resourceportal-tenant-mcp",
  title: "ResourcePortal Tenant MCP",
  version: "0.2.4",
  description: "Tenant-scoped ResourcePortal MCP using the authenticated user's existing RBAC.",
};
const maxToolBodyBytes = 256 * 1024;
const maxToolResponseBytes = 1024 * 1024;
const allowedMethods = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type McpCallContext = {
  tenantId: string;
  request: FastifyRequest;
  actor: AuthenticatedUser;
};

@Injectable()
export class TenantMcpProtocolService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: TenantMcpSettingsService,
  ) {}

  async handle(context: McpCallContext, input: unknown) {
    const rpc = this.parseRpc(input);
    const modern = this.isModernRequest(context.request, rpc.params);

    if (modern) {
      try {
        const protocolError = this.validateModernRequest(context.request, rpc);
        if (protocolError) {
          if (rpc.id === undefined || rpc.id === null) {
            return { statusCode: 202, body: undefined };
          }
          return this.error(rpc.id, protocolError.code, protocolError.message);
        }
      } catch (error) {
        if (rpc.id === undefined || rpc.id === null) {
          return { statusCode: 202, body: undefined };
        }
        const message = error instanceof Error ? error.message : "Invalid MCP request metadata";
        return this.error(rpc.id, -32602, message);
      }
    }

    if (rpc.id === undefined || rpc.id === null) {
      return { statusCode: 202, body: undefined };
    }

    try {
      switch (rpc.method) {
        case "initialize":
          if (modern) return this.error(rpc.id, -32601, "initialize is not available in MCP 2026-07-28");
          return this.result(rpc.id, this.legacyInitializeResult(rpc.params), false);
        case "server/discover":
          if (!modern) return this.error(rpc.id, -32601, "server/discover requires MCP 2026-07-28");
          return this.result(rpc.id, {
            supportedVersions: supportedProtocolVersions,
            capabilities: { tools: {} },
            ttlMs: 60_000,
            cacheScope: "private",
          }, true);
        case "ping":
          return this.result(rpc.id, {}, modern);
        case "tools/list":
          return this.result(rpc.id, {
            tools: this.tools(),
            ttlMs: 60_000,
            cacheScope: "private",
          }, modern);
        case "tools/call":
          return this.result(rpc.id, await this.callTool(context, rpc.params), modern);
        default:
          return this.error(rpc.id, -32601, `Method not found: ${rpc.method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP request failed";
      return this.error(rpc.id, -32602, message);
    }
  }

  private async callTool(context: McpCallContext, params: unknown) {
    const record = this.object(params, "tools/call params must be an object");
    const name = this.string(record.name, "tools/call name is required");
    const args = this.object(record.arguments ?? {}, "tool arguments must be an object");

    if (name === "resourceportal_tenant_endpoints") {
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor,
        toolName: name,
        success: true,
        requestId: this.header(context.request, "x-request-id"),
        correlationId: this.header(context.request, "x-correlation-id"),
      });
      return this.toolResult(this.endpointCatalog());
    }

    if (name !== "resourceportal_tenant_api") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    const method = this.string(args.method ?? "GET", "method must be a string").toUpperCase();
    if (!allowedMethods.has(method)) {
      throw new BadRequestException("method must be GET, POST, PATCH, PUT, or DELETE");
    }
    const path = this.string(args.path ?? "/", "path must be a string");
    const body = args.body;
    if (body !== undefined) {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > maxToolBodyBytes) {
        throw new BadRequestException("MCP tenant API request body exceeds 256 KiB");
      }
    }

    const bearer = this.bearer(context.request.headers.authorization);
    if (!bearer && this.config.get<string>("AUTH_MODE", "dev").toLowerCase() !== "dev") {
      throw new BadRequestException("OAuth bearer token is required for tenant API calls");
    }

    let statusCode: number | undefined;
    try {
      const response = await this.callTenantApi(context, method, path, body, bearer);
      statusCode = response.status;
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor,
        toolName: name,
        method,
        path,
        statusCode,
        success: response.ok,
        requestId: this.header(context.request, "x-request-id"),
        correlationId: this.header(context.request, "x-correlation-id"),
      });
      return this.httpToolResult(response.status, response.ok, response.payload);
    } catch (error) {
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor,
        toolName: name,
        method,
        path,
        statusCode,
        success: false,
        requestId: this.header(context.request, "x-request-id"),
        correlationId: this.header(context.request, "x-correlation-id"),
      });
      throw error;
    }
  }

  private async callTenantApi(
    context: McpCallContext,
    method: string,
    requestedPath: string,
    body: unknown,
    bearer?: string,
  ) {
    const tenantRoot = `/api/tenants/${encodeURIComponent(context.tenantId)}`;
    const normalizedPath = requestedPath === "" || requestedPath === "/" ? "" : requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`;
    if (normalizedPath.includes("://") || normalizedPath.startsWith("//")) {
      throw new BadRequestException("path must be relative to this tenant API");
    }

    const port = this.config.get<number>("PORT", 3000);
    const target = new URL(`${tenantRoot}${normalizedPath}`, `http://127.0.0.1:${port}`);
    if (target.pathname !== tenantRoot && !target.pathname.startsWith(`${tenantRoot}/`)) {
      throw new BadRequestException("path escapes the tenant API boundary");
    }
    if (target.pathname === `${tenantRoot}/mcp` || target.pathname.startsWith(`${tenantRoot}/mcp/`)) {
      throw new BadRequestException("MCP cannot recursively call its own transport endpoint");
    }

    const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.8" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else if (context.request.headers["x-dev-user-id"]) {
      headers["x-dev-user-id"] = this.header(context.request, "x-dev-user-id")!;
    }
    const requestId = this.header(context.request, "x-request-id");
    const correlationId = this.header(context.request, "x-correlation-id");
    if (requestId) headers["x-request-id"] = requestId;
    if (correlationId) headers["x-correlation-id"] = correlationId;
    if (body !== undefined && method !== "GET") headers["content-type"] = "application/json";

    const response = await fetch(target, {
      method,
      headers,
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const boundedText = Buffer.byteLength(text, "utf8") > maxToolResponseBytes
      ? `${text.slice(0, maxToolResponseBytes)}\n...[response truncated at 1 MiB]`
      : text;
    let payload: unknown = boundedText;
    if (boundedText) {
      try {
        payload = JSON.parse(boundedText);
      } catch {
        payload = boundedText;
      }
    } else {
      payload = null;
    }
    return { status: response.status, ok: response.ok, payload };
  }

  private tools() {
    return [
      {
        name: "resourceportal_tenant_endpoints",
        description:
          "Return a concise catalog of common ResourcePortal tenant API paths. Use this before resourceportal_tenant_api when you need to discover the path for an operation.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "resourceportal_tenant_api",
        description:
          "Call ResourcePortal's existing tenant-scoped API as the authenticated OAuth user. Paths are relative to /api/tenants/{tenantId}. The user's normal tenant RBAC is enforced on every call, so MCP never grants permissions the user does not already have.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
              default: "GET",
            },
            path: {
              type: "string",
              description:
                "Tenant-relative API path, for example /app-groups, /billing, /volumes, /registries, /domains, /operations, or /audit-log. Query strings are allowed.",
            },
            body: {
              type: "object",
              description: "JSON request body for POST, PATCH, PUT, or DELETE operations.",
              additionalProperties: true,
            },
          },
        },
      },
    ];
  }

  private endpointCatalog() {
    return {
      tenantRoot: "/",
      common: [
        { path: "/app-groups", methods: ["GET", "POST"], purpose: "App Groups" },
        { path: "/app-groups/{appGroupId}", methods: ["GET", "DELETE"], purpose: "App Group detail" },
        { path: "/app-groups/{appGroupId}/deploy", methods: ["POST"], purpose: "Deploy pending App Group changes" },
        { path: "/app-groups/{appGroupId}/runtime/start", methods: ["POST"], purpose: "Start an App Group" },
        { path: "/app-groups/{appGroupId}/runtime/stop", methods: ["POST"], purpose: "Stop an App Group" },
        { path: "/app-groups/{appGroupId}/runtime/restart", methods: ["POST"], purpose: "Restart an App Group" },
        { path: "/volumes", methods: ["GET", "POST"], purpose: "Tenant volumes" },
        { path: "/registries", methods: ["GET", "POST"], purpose: "Container registries" },
        { path: "/domains", methods: ["GET", "POST"], purpose: "Domains" },
        { path: "/billing", methods: ["GET"], purpose: "Billing account" },
        { path: "/quota", methods: ["GET", "PATCH"], purpose: "Tenant quota" },
        { path: "/memberships", methods: ["GET", "POST"], purpose: "Tenant memberships" },
        { path: "/groups", methods: ["GET", "POST"], purpose: "Tenant groups" },
        { path: "/operations", methods: ["GET"], purpose: "Operations" },
        { path: "/audit-log", methods: ["GET"], purpose: "Audit log" },
      ],
      rule: "Every call uses the authenticated user's existing tenant RBAC. A 403 means the user's ResourcePortal permissions do not allow that operation.",
    };
  }

  private httpToolResult(status: number, ok: boolean, payload: unknown) {
    const structuredContent = { status, ok, data: payload };
    return {
      isError: !ok,
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    };
  }

  private toolResult(payload: unknown) {
    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }

  private isModernRequest(request: FastifyRequest, params: unknown) {
    const headerVersion = this.header(request, "mcp-protocol-version");
    if (headerVersion === modernProtocolVersion) return true;
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    const meta = (params as Record<string, unknown>)._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
    return (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"] === modernProtocolVersion;
  }

  private validateModernRequest(
    request: FastifyRequest,
    rpc: { method: string; params: unknown; id: unknown },
  ): { code: number; message: string } | undefined {
    const headerVersion = this.header(request, "mcp-protocol-version");
    if (headerVersion !== modernProtocolVersion) {
      return { code: -32020, message: `MCP-Protocol-Version must be ${modernProtocolVersion}` };
    }
    const methodHeader = this.header(request, "mcp-method");
    if (methodHeader !== rpc.method) {
      return { code: -32020, message: "Mcp-Method header must match the JSON-RPC method" };
    }
    if (rpc.method === "tools/call") {
      const params = this.object(rpc.params, "tools/call params must be an object");
      const name = this.string(params.name, "tools/call name is required");
      if (this.header(request, "mcp-name") !== name) {
        return { code: -32020, message: "Mcp-Name header must match params.name" };
      }
    }

    const params = this.object(rpc.params, "MCP 2026-07-28 requests require params");
    const meta = this.object(params._meta, "MCP 2026-07-28 requests require params._meta");
    if (meta["io.modelcontextprotocol/protocolVersion"] !== modernProtocolVersion) {
      return { code: -32022, message: `Unsupported MCP protocol version; expected ${modernProtocolVersion}` };
    }
    const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      return { code: -32602, message: "MCP 2026-07-28 requests require clientCapabilities in params._meta" };
    }
    const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
    if (clientInfo !== undefined) {
      if (!clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo)) {
        return { code: -32602, message: "clientInfo must be an object when provided" };
      }
      const info = clientInfo as Record<string, unknown>;
      if (typeof info.name !== "string" || !info.name || typeof info.version !== "string" || !info.version) {
        return { code: -32602, message: "clientInfo requires non-empty name and version" };
      }
    }
    return undefined;
  }

  private legacyInitializeResult(params: unknown) {
    let requestedVersion: string | undefined;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const value = (params as Record<string, unknown>).protocolVersion;
      if (typeof value === "string") requestedVersion = value;
    }
    const protocolVersion =
      requestedVersion && supportedLegacyVersions.has(requestedVersion)
        ? requestedVersion
        : legacyProtocolVersion;
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo,
    };
  }

  private parseRpc(input: unknown) {
    const rpc = this.object(input, "MCP body must be a JSON-RPC object") as JsonRpcRequest;
    if (rpc.jsonrpc !== "2.0") throw new BadRequestException("jsonrpc must be 2.0");
    const method = this.string(rpc.method, "JSON-RPC method is required");
    return { id: rpc.id, method, params: rpc.params };
  }

  private result(id: unknown, result: unknown, modern: boolean) {
    if (!modern || !result || typeof result !== "object" || Array.isArray(result)) {
      return { statusCode: 200, body: { jsonrpc: "2.0", id, result } };
    }
    return {
      statusCode: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          ...(result as Record<string, unknown>),
          resultType: "complete",
          _meta: {
            ...(((result as Record<string, unknown>)._meta as Record<string, unknown> | undefined) ?? {}),
            "io.modelcontextprotocol/serverInfo": serverInfo,
          },
        },
      },
    };
  }

  private error(id: unknown, code: number, message: string) {
    return {
      statusCode: 200,
      body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    };
  }

  private object(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(message);
    }
    return value as Record<string, unknown>;
  }

  private string(value: unknown, message: string) {
    if (typeof value !== "string" || value.length === 0) throw new BadRequestException(message);
    return value;
  }

  private bearer(header: string | undefined) {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
  }

  private header(request: FastifyRequest, name: string) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
