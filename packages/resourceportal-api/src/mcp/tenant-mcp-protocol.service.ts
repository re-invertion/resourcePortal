import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/server";
import { FastifyReply, FastifyRequest } from "fastify";
import { AuthenticatedUser } from "../auth/types";
import { protectedResourceMetadataUrl } from "./mcp-oauth";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

const serverInfo = {
  name: "resourceportal-tenant-mcp",
  title: "ResourcePortal Tenant MCP",
  version: "0.2.10",
  description:
    "Tenant-scoped ResourcePortal MCP using the authenticated user's existing ResourcePortal RBAC.",
};

const maxToolBodyBytes = 256 * 1024;
const maxToolResponseBytes = 1024 * 1024;
const allowedMethods = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";

type McpCallContext = {
  tenantId: string;
  request: FastifyRequest;
  actor?: AuthenticatedUser;
  hasInteractiveCredential: boolean;
};

type SecurityScheme = {
  type: "oauth2";
  scopes: string[];
};

type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  securitySchemes: SecurityScheme[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  _meta: Record<string, unknown>;
};

type TenantApiResult = {
  status: number;
  ok: boolean;
  payload: unknown;
};

@Injectable()
export class TenantMcpProtocolService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: TenantMcpSettingsService,
  ) {}

  async createHttpHandler(context: McpCallContext) {
    const { Server, createMcpHandler } = await import("@modelcontextprotocol/server");

    return createMcpHandler(
      () => {
        const server = new Server(serverInfo, {
          capabilities: { tools: {} },
          instructions:
            "Use focused ResourcePortal tools whenever possible. Read tools are safe to call to inspect tenant state. Runtime/deploy tools change tenant workloads and should only be called when the user asks for that action. ResourcePortal enforces the connected user's existing tenant RBAC and never grants extra permissions through MCP.",
          cacheHints: {
            "tools/list": { ttlMs: 60_000, cacheScope: "private" },
            "server/discover": { ttlMs: 60_000, cacheScope: "private" },
          },
        });

        server.setRequestHandler("tools/list", () => {
          return {
            tools: this.tools(context),
          } as unknown as ListToolsResult;
        });

        server.setRequestHandler("tools/call", async (request) => {
          return this.callTool(
            context,
            request.params.name,
            request.params.arguments ?? {},
          );
        });

        return server;
      },
      { legacy: "stateless" },
    );
  }

  async handleHttp(context: McpCallContext, reply: FastifyReply) {
    const [{ toNodeHandler }, handler] = await Promise.all([
      import("@modelcontextprotocol/node"),
      this.createHttpHandler(context),
    ]);
    const nodeHandler = toNodeHandler(handler);
    reply.raw.setHeader("cache-control", "no-store");
    reply.hijack();
    try {
      await nodeHandler(context.request.raw, reply.raw, context.request.body);
    } finally {
      await handler.close();
    }
  }

  private async callTool(
    context: McpCallContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!context.actor || !context.hasInteractiveCredential) {
      return this.authenticationRequired(context);
    }

    switch (name) {
      case "resourceportal_profile":
        await this.recordToolCall(context, name, true);
        return this.toolResult({
          user: {
            id: context.actor.id,
            email: context.actor.email,
            displayName: context.actor.displayName,
          },
          tenantId: context.tenantId,
        });

      case "resourceportal_list_app_groups":
        return this.callFocusedTool(context, name, "GET", "/app-groups");
      case "resourceportal_get_app_group":
        return this.callFocusedTool(
          context,
          name,
          "GET",
          `/app-groups/${encodeURIComponent(this.uuid(args.appGroupId, "appGroupId"))}`,
        );
      case "resourceportal_deploy_app_group":
        return this.callFocusedTool(
          context,
          name,
          "POST",
          `/app-groups/${encodeURIComponent(this.uuid(args.appGroupId, "appGroupId"))}/deploy`,
        );
      case "resourceportal_start_app_group":
        return this.callFocusedTool(
          context,
          name,
          "POST",
          `/app-groups/${encodeURIComponent(this.uuid(args.appGroupId, "appGroupId"))}/runtime/start`,
        );
      case "resourceportal_stop_app_group":
        return this.callFocusedTool(
          context,
          name,
          "POST",
          `/app-groups/${encodeURIComponent(this.uuid(args.appGroupId, "appGroupId"))}/runtime/stop`,
        );
      case "resourceportal_restart_app_group":
        return this.callFocusedTool(
          context,
          name,
          "POST",
          `/app-groups/${encodeURIComponent(this.uuid(args.appGroupId, "appGroupId"))}/runtime/restart`,
        );
      case "resourceportal_list_volumes":
        return this.callFocusedTool(context, name, "GET", "/volumes");
      case "resourceportal_list_registries":
        return this.callFocusedTool(context, name, "GET", "/registries");
      case "resourceportal_list_domains":
        return this.callFocusedTool(context, name, "GET", "/domains");
      case "resourceportal_get_billing":
        return this.callFocusedTool(context, name, "GET", "/billing");
      case "resourceportal_get_quota":
        return this.callFocusedTool(context, name, "GET", "/quota");
      case "resourceportal_list_memberships":
        return this.callFocusedTool(context, name, "GET", "/memberships");
      case "resourceportal_list_groups":
        return this.callFocusedTool(context, name, "GET", "/groups");
      case "resourceportal_list_operations":
        return this.callFocusedTool(context, name, "GET", "/operations");
      case "resourceportal_list_audit_log":
        return this.callFocusedTool(context, name, "GET", "/audit-log");

      case "resourceportal_tenant_endpoints":
        await this.recordToolCall(context, name, true);
        return this.toolResult(this.endpointCatalog());

      case "resourceportal_tenant_api":
        return this.callCompatibilityTool(context, name, args);

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown ResourcePortal tool: ${name}` }],
        };
    }
  }

  private async callFocusedTool(
    context: McpCallContext,
    toolName: string,
    method: string,
    path: string,
  ) {
    return this.executeTenantApiCall(context, toolName, method, path);
  }

  private async callCompatibilityTool(
    context: McpCallContext,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    const method = this.string(args.method ?? "GET", "method must be a string").toUpperCase();
    if (!allowedMethods.has(method)) {
      throw new BadRequestException(
        "method must be GET, POST, PATCH, PUT, or DELETE",
      );
    }
    const path = this.string(args.path ?? "/", "path must be a string");
    const body = args.body;
    if (body !== undefined) {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > maxToolBodyBytes) {
        throw new BadRequestException(
          "MCP tenant API request body exceeds 256 KiB",
        );
      }
    }
    return this.executeTenantApiCall(
      context,
      toolName,
      method,
      path,
      body,
    );
  }

  private async executeTenantApiCall(
    context: McpCallContext,
    toolName: string,
    method: string,
    path: string,
    body?: unknown,
  ) {
    let statusCode: number | undefined;
    try {
      const response = await this.callTenantApi(context, method, path, body);
      statusCode = response.status;
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor!,
        toolName,
        method,
        path,
        statusCode,
        success: response.ok,
        requestId: this.header(context.request, "x-request-id"),
        correlationId: this.header(context.request, "x-correlation-id"),
      });
      return this.httpToolResult(response);
    } catch (error) {
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor!,
        toolName,
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

  private async recordToolCall(
    context: McpCallContext,
    toolName: string,
    success: boolean,
  ) {
    if (!context.actor) return;
    await this.settings.recordToolCall({
      tenantId: context.tenantId,
      actor: context.actor,
      toolName,
      success,
      requestId: this.header(context.request, "x-request-id"),
      correlationId: this.header(context.request, "x-correlation-id"),
    });
  }

  private async callTenantApi(
    context: McpCallContext,
    method: string,
    requestedPath: string,
    body?: unknown,
  ): Promise<TenantApiResult> {
    const tenantRoot = `/api/tenants/${encodeURIComponent(context.tenantId)}`;
    const normalizedPath =
      requestedPath === "" || requestedPath === "/"
        ? ""
        : requestedPath.startsWith("/")
          ? requestedPath
          : `/${requestedPath}`;
    if (
      normalizedPath.includes("://") ||
      normalizedPath.startsWith("//")
    ) {
      throw new BadRequestException(
        "path must be relative to this tenant API",
      );
    }

    const port = this.config.get<number>("PORT", 3000);
    const target = new URL(
      `${tenantRoot}${normalizedPath}`,
      `http://127.0.0.1:${port}`,
    );
    if (
      target.pathname !== tenantRoot &&
      !target.pathname.startsWith(`${tenantRoot}/`)
    ) {
      throw new BadRequestException(
        "path escapes the tenant API boundary",
      );
    }
    if (
      target.pathname === `${tenantRoot}/mcp` ||
      target.pathname.startsWith(`${tenantRoot}/mcp/`)
    ) {
      throw new BadRequestException(
        "MCP cannot recursively call its own transport endpoint",
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json, text/plain;q=0.8",
    };
    const bearer = this.bearer(context.request.headers.authorization);
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    } else {
      const devUserId = this.header(context.request, "x-dev-user-id");
      if (devUserId) headers["x-dev-user-id"] = devUserId;
    }

    const requestId = this.header(context.request, "x-request-id");
    const correlationId = this.header(context.request, "x-correlation-id");
    if (requestId) headers["x-request-id"] = requestId;
    if (correlationId) headers["x-correlation-id"] = correlationId;
    if (body !== undefined && method !== "GET") {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(target, {
      method,
      headers,
      body:
        body !== undefined && method !== "GET"
          ? JSON.stringify(body)
          : undefined,
    });
    const text = await response.text();
    const boundedText =
      Buffer.byteLength(text, "utf8") > maxToolResponseBytes
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

    return {
      status: response.status,
      ok: response.ok,
      payload,
    };
  }

  private tools(context: McpCallContext): ToolDescriptor[] {
    const securitySchemes = this.securitySchemes();
    const commonMeta = {
      securitySchemes,
    };
    const noArgs = this.objectSchema({});
    const appGroupInput = this.objectSchema(
      {
        appGroupId: {
          type: "string",
          format: "uuid",
          description: "ResourcePortal App Group UUID.",
        },
      },
      ["appGroupId"],
    );
    const apiOutput = this.apiOutputSchema();

    const readTool = (
      name: string,
      title: string,
      description: string,
      inputSchema: Record<string, unknown> = noArgs,
    ): ToolDescriptor => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema: apiOutput,
      securitySchemes,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ...commonMeta,
        "openai/toolInvocation/invoking": `Reading ${title.toLowerCase()}…`,
        "openai/toolInvocation/invoked": `${title} loaded`,
      },
    });

    const actionTool = (
      name: string,
      title: string,
      description: string,
      destructiveHint: boolean,
    ): ToolDescriptor => ({
      name,
      title,
      description,
      inputSchema: appGroupInput,
      outputSchema: apiOutput,
      securitySchemes,
      annotations: {
        readOnlyHint: false,
        destructiveHint,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ...commonMeta,
        "openai/toolInvocation/invoking": `${title}…`,
        "openai/toolInvocation/invoked": `${title} requested`,
      },
    });

    return [
      {
        name: "resourceportal_profile",
        title: "ResourcePortal profile",
        description:
          "Return the connected ResourcePortal user identity and the tenant ID for this MCP connection. Use this to identify which ResourcePortal account is connected.",
        inputSchema: noArgs,
        outputSchema: this.objectSchema(
          {
            user: {
              type: "object",
              additionalProperties: false,
              required: ["id", "email", "displayName"],
              properties: {
                id: { type: "string" },
                email: { type: "string" },
                displayName: { type: "string" },
              },
            },
            tenantId: { type: "string", format: "uuid" },
          },
          ["user", "tenantId"],
        ),
        securitySchemes,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          ...commonMeta,
          "openai/profile": true,
          "openai/toolInvocation/invoking": "Reading ResourcePortal profile…",
          "openai/toolInvocation/invoked": "ResourcePortal profile loaded",
        },
      },
      readTool(
        "resourceportal_list_app_groups",
        "List App Groups",
        "List App Groups in the connected ResourcePortal tenant.",
      ),
      readTool(
        "resourceportal_get_app_group",
        "Get App Group",
        "Get one ResourcePortal App Group by UUID, including its current configuration and runtime state.",
        appGroupInput,
      ),
      actionTool(
        "resourceportal_deploy_app_group",
        "Deploy App Group",
        "Deploy pending changes for one App Group. This can change running tenant workloads.",
        false,
      ),
      actionTool(
        "resourceportal_start_app_group",
        "Start App Group",
        "Start the workloads in one App Group.",
        false,
      ),
      actionTool(
        "resourceportal_stop_app_group",
        "Stop App Group",
        "Stop the workloads in one App Group. This interrupts the applications in that App Group.",
        true,
      ),
      actionTool(
        "resourceportal_restart_app_group",
        "Restart App Group",
        "Restart the workloads in one App Group. This can briefly interrupt the applications in that App Group.",
        true,
      ),
      readTool(
        "resourceportal_list_volumes",
        "List Volumes",
        "List tenant volumes and their current state.",
      ),
      readTool(
        "resourceportal_list_registries",
        "List Registries",
        "List container registries configured for the tenant.",
      ),
      readTool(
        "resourceportal_list_domains",
        "List Domains",
        "List tenant domains and routing state.",
      ),
      readTool(
        "resourceportal_get_billing",
        "Get Billing",
        "Read the tenant billing account and current credit information.",
      ),
      readTool(
        "resourceportal_get_quota",
        "Get Quota",
        "Read the tenant quota and current allocation limits.",
      ),
      readTool(
        "resourceportal_list_memberships",
        "List Memberships",
        "List tenant memberships visible to the connected user.",
      ),
      readTool(
        "resourceportal_list_groups",
        "List Groups",
        "List tenant groups visible to the connected user.",
      ),
      readTool(
        "resourceportal_list_operations",
        "List Operations",
        "List recent tenant operations and their state.",
      ),
      readTool(
        "resourceportal_list_audit_log",
        "List Audit Log",
        "List tenant audit events visible to the connected user.",
      ),
      {
        name: "resourceportal_tenant_endpoints",
        title: "ResourcePortal endpoint catalog",
        description:
          "Compatibility helper returning common tenant-relative API paths. Prefer the focused ResourcePortal tools for normal use.",
        inputSchema: noArgs,
        outputSchema: this.objectSchema({
          tenantRoot: { type: "string" },
          common: { type: "array", items: { type: "object" } },
          rule: { type: "string" },
        }),
        securitySchemes,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: commonMeta,
      },
      {
        name: "resourceportal_tenant_api",
        title: "ResourcePortal tenant API compatibility",
        description:
          "Advanced compatibility escape hatch for existing MCP clients. Call a tenant-relative ResourcePortal API path using the connected user's RBAC. Prefer focused tools because this tool can perform both reads and writes.",
        inputSchema: this.objectSchema(
          {
            method: {
              type: "string",
              enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
              default: "GET",
            },
            path: {
              type: "string",
              description:
                "Tenant-relative API path such as /app-groups, /volumes, /domains, /operations, or /audit-log.",
            },
            body: {
              type: "object",
              additionalProperties: true,
              description: "Optional JSON body for write operations.",
            },
          },
          ["path"],
        ),
        outputSchema: apiOutput,
        securitySchemes,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          ...commonMeta,
          "openai/toolInvocation/invoking": "Calling ResourcePortal tenant API…",
          "openai/toolInvocation/invoked": "ResourcePortal tenant API call finished",
        },
      },
    ].map((tool) => ({
      ...tool,
      _meta: {
        ...tool._meta,
        "resourceportal/tenantId": context.tenantId,
      },
    }));
  }

  private securitySchemes(): SecurityScheme[] {
    return [
      {
        type: "oauth2",
        scopes: this.oauthScopes(),
      },
    ];
  }

  private oauthScopes() {
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
    const organizationId = this.config.get<string>(
      "ZITADEL_ORGANIZATION_ID",
    );
    return [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...(projectId
        ? [`urn:zitadel:iam:org:project:id:${projectId}:aud`]
        : []),
      ...(organizationId
        ? [`urn:zitadel:iam:org:id:${organizationId}`]
        : []),
    ];
  }

  private authenticationRequired(context: McpCallContext): CallToolResult {
    const metadata = protectedResourceMetadataUrl(
      context.request,
      context.tenantId,
    );
    const challenge = metadata
      ? `Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="Connect your ResourcePortal account to use this tool"`
      : 'Bearer error="insufficient_scope", error_description="Connect your ResourcePortal account to use this tool"';

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Authentication required. Connect your ResourcePortal account and try again.",
        },
      ],
      _meta: {
        "mcp/www_authenticate": [challenge],
      },
    };
  }

  private httpToolResult(response: TenantApiResult): CallToolResult {
    const structuredContent = {
      status: response.status,
      ok: response.ok,
      data: response.payload,
    };
    return {
      isError: !response.ok,
      structuredContent,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
    };
  }

  private toolResult(payload: Record<string, unknown>): CallToolResult {
    return {
      structuredContent: payload,
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private endpointCatalog(): Record<string, unknown> {
    return {
      tenantRoot: "/",
      common: [
        {
          path: "/app-groups",
          methods: ["GET", "POST"],
          purpose: "App Groups",
        },
        {
          path: "/app-groups/{appGroupId}",
          methods: ["GET", "DELETE"],
          purpose: "App Group detail",
        },
        {
          path: "/app-groups/{appGroupId}/deploy",
          methods: ["POST"],
          purpose: "Deploy pending App Group changes",
        },
        {
          path: "/app-groups/{appGroupId}/runtime/start",
          methods: ["POST"],
          purpose: "Start an App Group",
        },
        {
          path: "/app-groups/{appGroupId}/runtime/stop",
          methods: ["POST"],
          purpose: "Stop an App Group",
        },
        {
          path: "/app-groups/{appGroupId}/runtime/restart",
          methods: ["POST"],
          purpose: "Restart an App Group",
        },
        { path: "/volumes", methods: ["GET", "POST"], purpose: "Tenant volumes" },
        {
          path: "/registries",
          methods: ["GET", "POST"],
          purpose: "Container registries",
        },
        { path: "/domains", methods: ["GET", "POST"], purpose: "Domains" },
        { path: "/billing", methods: ["GET"], purpose: "Billing account" },
        { path: "/quota", methods: ["GET", "PATCH"], purpose: "Tenant quota" },
        {
          path: "/memberships",
          methods: ["GET", "POST"],
          purpose: "Tenant memberships",
        },
        { path: "/groups", methods: ["GET", "POST"], purpose: "Tenant groups" },
        { path: "/operations", methods: ["GET"], purpose: "Operations" },
        { path: "/audit-log", methods: ["GET"], purpose: "Audit log" },
      ],
      rule:
        "Every call uses the connected user's existing ResourcePortal tenant RBAC. A 403 means that user's ResourcePortal permissions do not allow the operation.",
    };
  }

  private objectSchema(
    properties: Record<string, unknown>,
    required: string[] = [],
  ) {
    return {
      $schema: jsonSchemaDialect,
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  private apiOutputSchema() {
    return this.objectSchema(
      {
        status: { type: "integer" },
        ok: { type: "boolean" },
        data: {},
      },
      ["status", "ok", "data"],
    );
  }

  private uuid(value: unknown, name: string) {
    const text = this.string(value, `${name} must be a UUID`);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        text,
      )
    ) {
      throw new BadRequestException(`${name} must be a UUID`);
    }
    return text;
  }

  private string(value: unknown, message: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new BadRequestException(message);
    }
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
