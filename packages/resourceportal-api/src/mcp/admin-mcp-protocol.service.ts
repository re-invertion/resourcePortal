import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/server";
import { FastifyReply, FastifyRequest } from "fastify";
import { isPlatformAdminUser } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { AdminMcpAuditService } from "./admin-mcp-audit.service";
import { adminProtectedResourceMetadataUrl } from "./mcp-oauth";

const serverInfo = {
  name: "resourceportal-admin-mcp",
  title: "ResourcePortal Admin MCP",
  version: "0.2.62",
  description:
    "Platform-administration MCP for ResourcePortal. It exposes explicit Platform Admin capabilities without granting tenant-user permissions.",
};

const maxToolBodyBytes = 256 * 1024;
const maxToolResponseBytes = 1024 * 1024;
const maxImageBytes = 4 * 1024 * 1024;
const jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";

type McpCallContext = {
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

type AdminApiResult = {
  status: number;
  ok: boolean;
  payload: unknown;
};

type JsonExecution = {
  kind: "json";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  postProcess?: (payload: unknown) => unknown;
};

type ImageExecution = {
  kind: "image";
  path: string;
};

type Execution = JsonExecution | ImageExecution;

type AdminToolDefinition = ToolDescriptor & {
  execute: (args: Record<string, unknown>) => Execution;
};

@Injectable()
export class AdminMcpProtocolService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AdminMcpAuditService,
  ) {}

  async createHttpHandler(context: McpCallContext) {
    const { Server, createMcpHandler } =
      await import("@modelcontextprotocol/server");

    return createMcpHandler(
      () => {
        const server = new Server(serverInfo, {
          capabilities: { tools: {} },
          instructions:
            "This is ResourcePortal Platform Admin MCP, separate from Tenant MCP. Use explicit admin tools only for platform administration. Platform administrators have read-only global visibility of tenants/users and do not inherit tenant RBAC, cannot mutate tenant workloads, memberships, tenant settings, or tenant resources through this MCP. Secret-bearing update tools accept replacement credentials but never expose stored secret values. There is no generic HTTP, SQL, filesystem, or shell tool.",
          cacheHints: {
            "tools/list": { ttlMs: 60_000, cacheScope: "private" },
            "server/discover": { ttlMs: 60_000, cacheScope: "private" },
          },
        });

        server.setRequestHandler("tools/list", async () => {
          return {
            tools: this.tools(),
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
    if (!(await isPlatformAdminUser(this.config, this.prisma, context.actor))) {
      await this.recordToolCall(context, name, false);
      return this.forbiddenToolResult(
        "ResourcePortal platform administrator access is required",
      );
    }

    if (name === "resourceportal_admin_profile") {
      await this.recordToolCall(context, name, true);
      return this.toolResult({
        user: {
          id: context.actor.id,
          email: context.actor.email,
          displayName: context.actor.displayName,
        },
        scope: "platform",
        platformAdmin: true,
        tenantAdministration: "read-only-global-directory",
      });
    }

    if (name === "resourceportal_admin_capabilities") {
      await this.recordToolCall(context, name, true);
      return this.toolResult({
        scope: "platform",
        transport: "Streamable HTTP",
        protocol: "MCP 2026-07-28 with 2025-era compatibility",
        boundaries: {
          tenantDirectory: "read-only",
          userDirectory: "read-only",
          tenantWorkloads: "not available",
          tenantMemberships: "not available",
          tenantConfiguration: "not available",
          tenantSecrets: "not available",
          arbitraryHttp: false,
          arbitrarySql: false,
          shellExecution: false,
          serviceIdentityAccess: false,
        },
        toolCount: this.tools().length,
      });
    }

    const definition = this.definitions().find((tool) => tool.name === name);
    if (!definition) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown ResourcePortal Admin tool: ${name}` },
        ],
      };
    }

    const execution = definition.execute(args);
    if (execution.kind === "image") {
      return this.executeImageCall(context, name, execution.path);
    }
    return this.executeJsonCall(context, name, execution);
  }

  private tools(): ToolDescriptor[] {
    const definitions = this.definitions().map(({ execute: _execute, ...tool }) => tool);
    const securitySchemes = this.securitySchemes();
    const commonMeta = { securitySchemes };
    const noArgs = this.objectSchema({});
    const profile: ToolDescriptor = {
      name: "resourceportal_admin_profile",
      title: "ResourcePortal Admin profile",
      description:
        "Return the connected ResourcePortal platform administrator identity and the fixed platform scope for this MCP connection.",
      inputSchema: noArgs,
      outputSchema: this.objectSchema({
        user: { type: "object" },
        scope: { type: "string", const: "platform" },
        platformAdmin: { type: "boolean" },
        tenantAdministration: { type: "string" },
      }),
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
        "openai/toolInvocation/invoking": "Reading ResourcePortal Admin profile…",
        "openai/toolInvocation/invoked": "ResourcePortal Admin profile loaded",
      },
    };
    const capabilities: ToolDescriptor = {
      name: "resourceportal_admin_capabilities",
      title: "Admin MCP capabilities",
      description:
        "Describe the security boundaries and supported scope of ResourcePortal Admin MCP, including the read-only tenant/user directory limitation.",
      inputSchema: noArgs,
      outputSchema: this.objectSchema({
        scope: { type: "string" },
        transport: { type: "string" },
        protocol: { type: "string" },
        boundaries: { type: "object" },
        toolCount: { type: "integer" },
      }),
      securitySchemes,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: commonMeta,
    };
    return [profile, capabilities, ...definitions];
  }

  private definitions(): AdminToolDefinition[] {
    const noArgs = this.objectSchema({});
    const uuid = (description: string) => ({
      type: "string",
      format: "uuid",
      description,
    });
    const string = (description: string, extra: Record<string, unknown> = {}) => ({
      type: "string",
      description,
      ...extra,
    });
    const boolean = (description: string) => ({
      type: "boolean",
      description,
    });
    const stringArray = (description: string) => ({
      type: "array",
      items: { type: "string" },
      maxItems: 20,
      description,
    });

    const read = (
      name: string,
      title: string,
      description: string,
      path: string | ((args: Record<string, unknown>) => string),
      inputSchema: Record<string, unknown> = noArgs,
      postProcess?: (payload: unknown, args: Record<string, unknown>) => unknown,
    ): AdminToolDefinition =>
      this.definition({
        name,
        title,
        description,
        inputSchema,
        readOnly: true,
        destructive: false,
        idempotent: true,
        execute: (args) => ({
          kind: "json",
          method: "GET",
          path: typeof path === "function" ? path(args) : path,
          ...(postProcess
            ? { postProcess: (payload: unknown) => postProcess(payload, args) }
            : {}),
        }),
      });

    const write = (
      name: string,
      title: string,
      description: string,
      method: "POST" | "PATCH" | "DELETE",
      path: string | ((args: Record<string, unknown>) => string),
      inputSchema: Record<string, unknown>,
      body: ((args: Record<string, unknown>) => unknown) | undefined,
      destructive = false,
      idempotent = false,
    ): AdminToolDefinition =>
      this.definition({
        name,
        title,
        description,
        inputSchema,
        readOnly: false,
        destructive,
        idempotent,
        execute: (args) => ({
          kind: "json",
          method,
          path: typeof path === "function" ? path(args) : path,
          ...(body ? { body: body(args) } : {}),
        }),
      });

    const idSchema = (key: string, description: string) =>
      this.objectSchema({ [key]: uuid(description) }, [key]);

    const enabledSchema = this.objectSchema(
      { enabled: boolean("Whether the platform feature should be enabled.") },
      ["enabled"],
    );

    const tools: AdminToolDefinition[] = [
      read(
        "resourceportal_admin_health_live",
        "Platform liveness",
        "Read the ResourcePortal API liveness state and deployed version.",
        "/api/health/live",
      ),
      read(
        "resourceportal_admin_health_ready",
        "Platform readiness",
        "Read ResourcePortal readiness, deployed version, and PostgreSQL dependency state.",
        "/api/health/ready",
      ),
      read(
        "resourceportal_admin_health_worker",
        "Worker health",
        "Read durable worker heartbeat and reconciliation health.",
        "/api/health/worker",
      ),
      read(
        "resourceportal_admin_get_metrics",
        "Get platform metrics",
        "Read the ResourcePortal Prometheus metrics exposition as text.",
        "/api/metrics",
      ),
      read(
        "resourceportal_admin_list_tenants",
        "List tenants",
        "List the global tenant directory visible to Platform Admin. This is read-only and does not grant tenant membership or tenant permissions.",
        "/api/platform/tenants",
      ),
      read(
        "resourceportal_admin_list_users",
        "List users",
        "List the global ResourcePortal user directory visible to Platform Admin. This is read-only.",
        "/api/platform/users",
      ),

      read(
        "resourceportal_admin_get_swarm_cluster",
        "Get Swarm cluster",
        "Read observed Docker Swarm cluster state from ResourcePortal.",
        "/api/platform/swarm-cluster",
      ),
      write(
        "resourceportal_admin_reconcile_swarm_cluster",
        "Reconcile Swarm cluster",
        "Queue a platform Swarm reconciliation operation.",
        "POST",
        "/api/platform/swarm-cluster/reconcile",
        noArgs,
        undefined,
      ),
      read(
        "resourceportal_admin_list_remote_locations",
        "List remote locations",
        "List ResourcePortal Swarm remote locations and their observed state.",
        "/api/platform/remote-locations",
      ),
      read(
        "resourceportal_admin_get_remote_location",
        "Get remote location",
        "Get one ResourcePortal remote location by UUID.",
        (args) =>
          `/api/platform/remote-locations/${encodeURIComponent(this.uuid(args.remoteLocationId, "remoteLocationId"))}`,
        idSchema("remoteLocationId", "Remote Location UUID."),
      ),
      read(
        "resourceportal_admin_get_resource_usage",
        "Get platform resource usage",
        "Read aggregate platform infrastructure resource usage.",
        "/api/platform/resource-usage",
      ),
      write(
        "resourceportal_admin_set_remote_location_maintenance",
        "Set remote location maintenance",
        "Enter or exit maintenance for a ResourcePortal remote location by queuing the supported infrastructure operation.",
        "PATCH",
        (args) =>
          `/api/platform/remote-locations/${encodeURIComponent(this.uuid(args.remoteLocationId, "remoteLocationId"))}/maintenance`,
        this.objectSchema(
          {
            remoteLocationId: uuid("Remote Location UUID."),
            enabled: boolean("True to enter maintenance; false to leave maintenance."),
          },
          ["remoteLocationId", "enabled"],
        ),
        (args) => ({ enabled: this.boolean(args.enabled, "enabled") }),
        true,
      ),
      read(
        "resourceportal_admin_list_storage_backends",
        "List storage backends",
        "List platform storage backends and their health/maintenance state.",
        "/api/platform/storage-backends",
      ),
      read(
        "resourceportal_admin_get_storage_backend",
        "Get storage backend",
        "Get one platform storage backend by UUID.",
        (args) =>
          `/api/platform/storage-backends/${encodeURIComponent(this.uuid(args.storageBackendId, "storageBackendId"))}`,
        idSchema("storageBackendId", "Storage Backend UUID."),
      ),
      write(
        "resourceportal_admin_validate_storage_backend",
        "Validate storage backend",
        "Queue validation of one platform storage backend.",
        "POST",
        (args) =>
          `/api/platform/storage-backends/${encodeURIComponent(this.uuid(args.storageBackendId, "storageBackendId"))}/validate`,
        idSchema("storageBackendId", "Storage Backend UUID."),
        undefined,
      ),
      write(
        "resourceportal_admin_set_storage_backend_maintenance",
        "Set storage backend maintenance",
        "Enter or exit maintenance for one platform storage backend.",
        "PATCH",
        (args) =>
          `/api/platform/storage-backends/${encodeURIComponent(this.uuid(args.storageBackendId, "storageBackendId"))}/maintenance`,
        this.objectSchema(
          {
            storageBackendId: uuid("Storage Backend UUID."),
            enabled: boolean("True to enter maintenance; false to leave maintenance."),
          },
          ["storageBackendId", "enabled"],
        ),
        (args) => ({ enabled: this.boolean(args.enabled, "enabled") }),
        true,
      ),
      read(
        "resourceportal_admin_get_observability_diagnostics",
        "Get observability diagnostics",
        "Read ResourcePortal platform worker/reconciliation diagnostics.",
        "/api/platform/observability/diagnostics",
      ),
      read(
        "resourceportal_admin_list_operations",
        "List platform operations",
        "List recent platform-scoped durable operations whose tenantId is null.",
        "/api/platform/operations",
      ),
      read(
        "resourceportal_admin_get_operation",
        "Get platform operation",
        "Get one platform-scoped durable operation by UUID.",
        (args) =>
          `/api/platform/operations/${encodeURIComponent(this.uuid(args.operationId, "operationId"))}`,
        idSchema("operationId", "Platform Operation UUID."),
      ),
      read(
        "resourceportal_admin_list_operation_events",
        "List platform operation events",
        "List the durable event stream for one platform-scoped operation.",
        (args) =>
          `/api/platform/operations/${encodeURIComponent(this.uuid(args.operationId, "operationId"))}/events`,
        idSchema("operationId", "Platform Operation UUID."),
      ),
      write(
        "resourceportal_admin_retry_operation",
        "Retry platform operation",
        "Requeue a failed retryable platform-scoped operation. Tenant operations are not addressable through this tool.",
        "POST",
        (args) =>
          `/api/platform/operations/${encodeURIComponent(this.uuid(args.operationId, "operationId"))}/retry`,
        idSchema("operationId", "Platform Operation UUID."),
        undefined,
        true,
      ),
      read(
        "resourceportal_admin_list_audit_log",
        "List platform audit log",
        "Read platform-level audit events only (tenantId is null). Optional filters are forwarded to the platform audit endpoint.",
        (args) => this.platformAuditPath(args),
        this.objectSchema({
          action: { type: "string" },
          actor: { type: "string" },
          resourceType: { type: "string" },
          resourceId: { type: "string", format: "uuid" },
          result: { type: "string" },
          requestId: { type: "string" },
          correlationId: { type: "string" },
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          cursor: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        }),
      ),
      read(
        "resourceportal_admin_export_audit_log",
        "Export platform audit log",
        "Export platform-level audit events as JSON or CSV. Tenant audit entries are not included.",
        (args) => this.platformAuditPath(args, true),
        this.objectSchema({
          action: { type: "string" },
          actor: { type: "string" },
          resourceType: { type: "string" },
          resourceId: { type: "string", format: "uuid" },
          result: { type: "string" },
          requestId: { type: "string" },
          correlationId: { type: "string" },
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          format: { type: "string", enum: ["json", "csv"] },
        }),
      ),
      read(
        "resourceportal_admin_get_platform_maintenance",
        "Get platform maintenance",
        "Read global ResourcePortal maintenance state.",
        "/api/platform/maintenance",
      ),
      write(
        "resourceportal_admin_set_platform_maintenance",
        "Set platform maintenance",
        "Enable or disable global ResourcePortal maintenance mode.",
        "PATCH",
        "/api/platform/maintenance",
        this.objectSchema(
          {
            enabled: boolean("Whether maintenance mode is enabled."),
            reason: string("Optional operator-visible maintenance reason.", {
              maxLength: 500,
            }),
          },
          ["enabled"],
        ),
        (args) => this.pick(args, ["enabled", "reason"]),
        true,
      ),
      read(
        "resourceportal_admin_get_network_egress",
        "Get network egress policy",
        "Read the platform network-egress safety policy.",
        "/api/platform/network-egress",
      ),
      write(
        "resourceportal_admin_update_network_egress",
        "Update network egress policy",
        "Update the platform network-egress policy. Current product invariants may reject disabling mandatory egress controls.",
        "PATCH",
        "/api/platform/network-egress",
        enabledSchema,
        (args) => ({ enabled: this.boolean(args.enabled, "enabled") }),
        true,
      ),

      read(
        "resourceportal_admin_get_dns",
        "Get platform DNS",
        "Read platform-managed DNS integration state. Stored credential values are not returned.",
        "/api/platform/dns",
      ),
      write(
        "resourceportal_admin_update_dns",
        "Update platform DNS",
        "Update platform-managed DNS configuration. Credential fields replace stored values but are not returned by read tools.",
        "PATCH",
        "/api/platform/dns",
        this.objectSchema({
          enabled: boolean("Whether platform-managed DNS is enabled."),
          zoneId: string("Cloudflare zone identifier.", {
            pattern: "^[a-fA-F0-9]{32}$",
          }),
          apiToken: string("Replacement Cloudflare API token.", {
            minLength: 20,
            maxLength: 2048,
          }),
          oauthClientId: string("Replacement Cloudflare OAuth client ID.", {
            minLength: 3,
            maxLength: 512,
          }),
          oauthClientSecret: string(
            "Replacement Cloudflare OAuth client secret.",
            { minLength: 8, maxLength: 4096 },
          ),
        }),
        (args) =>
          this.pick(args, [
            "enabled",
            "zoneId",
            "apiToken",
            "oauthClientId",
            "oauthClientSecret",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_validate_dns",
        "Validate platform DNS",
        "Validate the configured platform DNS integration.",
        "POST",
        "/api/platform/dns/validate",
        noArgs,
        undefined,
      ),
      read(
        "resourceportal_admin_get_email",
        "Get platform email",
        "Read platform SMTP/email settings. Stored SMTP password values are not returned.",
        "/api/platform/email",
      ),
      write(
        "resourceportal_admin_update_email",
        "Update platform email",
        "Update platform SMTP/email settings. The password field is a replacement credential and is never echoed by Admin MCP.",
        "PATCH",
        "/api/platform/email",
        this.objectSchema({
          enabled: boolean("Whether platform email delivery is enabled."),
          host: string("SMTP host.", { maxLength: 255 }),
          port: { type: "integer", minimum: 1, maximum: 65535 },
          mode: {
            type: "string",
            enum: ["STARTTLS", "TLS", "PLAIN"],
            description: "SMTP transport mode.",
          },
          username: string("SMTP username.", { maxLength: 255 }),
          password: string("Replacement SMTP password.", { maxLength: 2048 }),
          fromEmail: {
            type: ["string", "null"],
            format: "email",
            maxLength: 320,
          },
          fromName: string("Sender display name.", { maxLength: 160 }),
          replyTo: {
            type: ["string", "null"],
            format: "email",
            maxLength: 320,
          },
        }),
        (args) =>
          this.pick(args, [
            "enabled",
            "host",
            "port",
            "mode",
            "username",
            "password",
            "fromEmail",
            "fromName",
            "replyTo",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_validate_email",
        "Validate platform email",
        "Validate the configured platform SMTP connection.",
        "POST",
        "/api/platform/email/validate",
        noArgs,
        undefined,
      ),
      write(
        "resourceportal_admin_send_test_email",
        "Send platform test email",
        "Send a test message through the configured platform email integration.",
        "POST",
        "/api/platform/email/test",
        this.objectSchema(
          {
            recipient: string("Email address that should receive the test message.", {
              format: "email",
              maxLength: 320,
            }),
          },
          ["recipient"],
        ),
        (args) => ({ recipient: this.string(args.recipient, "recipient") }),
      ),

      read(
        "resourceportal_admin_get_resource_bot",
        "Get ResourceBot platform settings",
        "Read platform ResourceBot provider/model settings. Stored API keys are not returned.",
        "/api/platform/resource-bot",
      ),
      write(
        "resourceportal_admin_update_resource_bot",
        "Update ResourceBot platform settings",
        "Update platform ResourceBot configuration. apiKey is treated as a replacement secret.",
        "PATCH",
        "/api/platform/resource-bot",
        this.objectSchema({
          enabled: boolean("Whether ResourceBot is enabled."),
          provider: { type: "string", enum: ["OpenAI"] },
          generationModel: string("Generation model identifier.", {
            minLength: 2,
            maxLength: 128,
          }),
          embeddingModel: string("Embedding model identifier.", {
            minLength: 2,
            maxLength: 128,
          }),
          apiKey: string("Replacement OpenAI API key.", {
            minLength: 20,
            maxLength: 4096,
          }),
        }),
        (args) =>
          this.pick(args, [
            "enabled",
            "provider",
            "generationModel",
            "embeddingModel",
            "apiKey",
          ]),
        true,
      ),
      read(
        "resourceportal_admin_list_resource_bot_prices",
        "List ResourceBot prices",
        "List effective-dated platform ResourceBot AI prices.",
        "/api/platform/resource-bot/prices",
      ),
      write(
        "resourceportal_admin_create_resource_bot_price",
        "Create ResourceBot price",
        "Create a new effective-dated ResourceBot AI price row.",
        "POST",
        "/api/platform/resource-bot/prices",
        this.objectSchema(
          {
            provider: { type: "string", enum: ["OpenAI"] },
            model: string("Model identifier.", { minLength: 2, maxLength: 128 }),
            effectiveFrom: string("ISO-8601 effective timestamp.", {
              format: "date-time",
            }),
            inputCreditsPer1M: string("Input credits per one million tokens."),
            cachedInputCreditsPer1M: string(
              "Cached-input credits per one million tokens.",
            ),
            outputCreditsPer1M: string("Output credits per one million tokens."),
            embeddingCreditsPer1M: string(
              "Embedding credits per one million tokens.",
            ),
          },
          [
            "provider",
            "model",
            "effectiveFrom",
            "inputCreditsPer1M",
            "cachedInputCreditsPer1M",
            "outputCreditsPer1M",
            "embeddingCreditsPer1M",
          ],
        ),
        (args) =>
          this.pick(args, [
            "provider",
            "model",
            "effectiveFrom",
            "inputCreditsPer1M",
            "cachedInputCreditsPer1M",
            "outputCreditsPer1M",
            "embeddingCreditsPer1M",
          ]),
      ),
      write(
        "resourceportal_admin_validate_resource_bot",
        "Validate ResourceBot",
        "Validate the configured ResourceBot provider connection.",
        "POST",
        "/api/platform/resource-bot/validate",
        noArgs,
        undefined,
      ),

      read(
        "resourceportal_admin_get_billing_usage_series",
        "Get tenant billing usage series",
        "Read one tenant's billing usage series from the Platform Admin billing view. This is billing observability only and does not grant tenant resource access.",
        (args) => {
          const params = new URLSearchParams({
            tenantId: this.uuid(args.tenantId, "tenantId"),
          });
          for (const key of ["from", "to", "bucket"] as const) {
            if (args[key] !== undefined) {
              params.set(key, this.string(args[key], key));
            }
          }
          return `/api/platform/billing/usage-series?${params.toString()}`;
        },
        this.objectSchema(
          {
            tenantId: uuid("Tenant UUID."),
            from: string("Optional ISO-8601 range start.", {
              format: "date-time",
            }),
            to: string("Optional ISO-8601 range end.", {
              format: "date-time",
            }),
            bucket: {
              type: "string",
              enum: ["15m", "2h", "12h", "1d"],
              description: "Aggregation bucket.",
            },
          },
          ["tenantId"],
        ),
      ),
      read(
        "resourceportal_admin_list_price_lists",
        "List price lists",
        "List effective-dated platform resource price lists.",
        "/api/platform/billing/price-lists",
      ),
      read(
        "resourceportal_admin_get_price_list",
        "Get price list",
        "Get one platform price list by UUID.",
        (args) =>
          `/api/platform/billing/price-lists/${encodeURIComponent(this.uuid(args.priceListId, "priceListId"))}`,
        idSchema("priceListId", "Price List UUID."),
      ),
      write(
        "resourceportal_admin_create_price_list",
        "Create price list",
        "Create an effective-dated resource price list.",
        "POST",
        "/api/platform/billing/price-lists",
        this.objectSchema(
          {
            effectiveFrom: string("ISO-8601 effective timestamp.", {
              format: "date-time",
            }),
            cpuCreditsPerVcpuHour: string("CPU credits per vCPU-hour."),
            memoryCreditsPerGbHour: string("Memory credits per GB-hour."),
            storageCreditsPerGbHour: string("Storage credits per GB-hour."),
            gpuCreditsPerGpuHour: string("GPU credits per GPU-hour."),
          },
          [
            "effectiveFrom",
            "cpuCreditsPerVcpuHour",
            "memoryCreditsPerGbHour",
            "storageCreditsPerGbHour",
            "gpuCreditsPerGpuHour",
          ],
        ),
        (args) =>
          this.pick(args, [
            "effectiveFrom",
            "cpuCreditsPerVcpuHour",
            "memoryCreditsPerGbHour",
            "storageCreditsPerGbHour",
            "gpuCreditsPerGpuHour",
          ]),
      ),
      read(
        "resourceportal_admin_list_vouchers",
        "List vouchers",
        "List platform billing vouchers and their status.",
        "/api/platform/billing/vouchers",
      ),
      read(
        "resourceportal_admin_get_voucher",
        "Get voucher",
        "Get one platform billing voucher by UUID.",
        (args) =>
          `/api/platform/billing/vouchers/${encodeURIComponent(this.uuid(args.voucherId, "voucherId"))}`,
        idSchema("voucherId", "Voucher UUID."),
      ),
      write(
        "resourceportal_admin_create_voucher",
        "Create voucher",
        "Create a new platform billing voucher.",
        "POST",
        "/api/platform/billing/vouchers",
        this.objectSchema(
          {
            valueCredits: string("Positive voucher value in credits."),
            expiresAt: string("Optional ISO-8601 expiry timestamp.", {
              format: "date-time",
            }),
          },
          ["valueCredits"],
        ),
        (args) => this.pick(args, ["valueCredits", "expiresAt"]),
      ),
      write(
        "resourceportal_admin_disable_voucher",
        "Disable voucher",
        "Disable one platform billing voucher.",
        "POST",
        (args) =>
          `/api/platform/billing/vouchers/${encodeURIComponent(this.uuid(args.voucherId, "voucherId"))}/disable`,
        idSchema("voucherId", "Voucher UUID."),
        undefined,
        true,
      ),
      write(
        "resourceportal_admin_record_payment",
        "Record billing payment",
        "Record a positive platform billing payment for a tenant. This adjusts billing state only; it does not grant tenant permissions.",
        "POST",
        "/api/platform/billing/payments",
        this.balanceMutationSchema(uuid, string, true, false),
        (args) =>
          this.pick(args, [
            "tenantId",
            "amountCredits",
            "reference",
            "reason",
            "sourceTransactionId",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_record_refund",
        "Record billing refund",
        "Record a platform billing refund for a tenant.",
        "POST",
        "/api/platform/billing/refunds",
        this.balanceMutationSchema(uuid, string, true, true),
        (args) =>
          this.pick(args, [
            "tenantId",
            "amountCredits",
            "reference",
            "reason",
            "sourceTransactionId",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_record_correction",
        "Record billing correction",
        "Record a signed platform billing correction for a tenant.",
        "POST",
        "/api/platform/billing/corrections",
        this.balanceMutationSchema(uuid, string, false, true),
        (args) =>
          this.pick(args, [
            "tenantId",
            "amountCredits",
            "reference",
            "reason",
            "sourceTransactionId",
          ]),
        true,
      ),

      read(
        "resourceportal_admin_list_identity_providers",
        "List platform identity providers",
        "List platform-scoped external identity providers.",
        "/api/platform/identity-providers",
      ),
      read(
        "resourceportal_admin_get_identity_provider",
        "Get platform identity provider",
        "Get one platform identity provider by UUID. Stored client secrets are not returned.",
        (args) =>
          `/api/platform/identity-providers/${encodeURIComponent(this.uuid(args.identityProviderId, "identityProviderId"))}`,
        idSchema("identityProviderId", "Identity Provider UUID."),
      ),
      write(
        "resourceportal_admin_create_identity_provider",
        "Create platform identity provider",
        "Create a platform-scoped OIDC or SAML identity provider.",
        "POST",
        "/api/platform/identity-providers",
        this.identityProviderSchema(string, stringArray, true, uuid),
        (args) =>
          this.pick(args, [
            "name",
            "protocol",
            "issuer",
            "metadataUrl",
            "clientId",
            "clientSecret",
            "scopes",
            "usePkce",
            "enabled",
          ]),
      ),
      write(
        "resourceportal_admin_update_identity_provider",
        "Update platform identity provider",
        "Update a platform-scoped identity provider. clientSecret is a replacement secret and is not returned.",
        "PATCH",
        (args) =>
          `/api/platform/identity-providers/${encodeURIComponent(this.uuid(args.identityProviderId, "identityProviderId"))}`,
        this.identityProviderSchema(string, stringArray, false, uuid),
        (args) =>
          this.pick(args, [
            "name",
            "protocol",
            "issuer",
            "metadataUrl",
            "clientId",
            "clientSecret",
            "scopes",
            "usePkce",
            "enabled",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_delete_identity_provider",
        "Delete platform identity provider",
        "Delete one platform-scoped identity provider.",
        "DELETE",
        (args) =>
          `/api/platform/identity-providers/${encodeURIComponent(this.uuid(args.identityProviderId, "identityProviderId"))}`,
        idSchema("identityProviderId", "Identity Provider UUID."),
        undefined,
        true,
      ),

      read(
        "resourceportal_admin_list_oauth_applications",
        "List platform OAuth applications",
        "List platform-scoped OAuth applications.",
        "/api/platform/oauth-applications",
      ),
      read(
        "resourceportal_admin_get_oauth_application",
        "Get platform OAuth application",
        "Get one platform-scoped OAuth application by UUID.",
        (args) =>
          `/api/platform/oauth-applications/${encodeURIComponent(this.uuid(args.applicationId, "applicationId"))}`,
        idSchema("applicationId", "OAuth Application UUID."),
      ),
      write(
        "resourceportal_admin_create_oauth_application",
        "Create platform OAuth application",
        "Create a platform-scoped OAuth application. Newly issued credentials may be returned once by the underlying API.",
        "POST",
        "/api/platform/oauth-applications",
        this.objectSchema(
          {
            name: string("Application name.", { minLength: 1, maxLength: 128 }),
            type: {
              type: "string",
              enum: ["Web", "SPA", "Native", "Machine"],
            },
            redirectUris: stringArray("OAuth redirect URIs."),
            postLogoutRedirectUris: stringArray("Post-logout redirect URIs."),
          },
          ["name", "type"],
        ),
        (args) =>
          this.pick(args, [
            "name",
            "type",
            "redirectUris",
            "postLogoutRedirectUris",
          ]),
      ),
      write(
        "resourceportal_admin_update_oauth_application",
        "Update platform OAuth application",
        "Update a platform-scoped OAuth application.",
        "PATCH",
        (args) =>
          `/api/platform/oauth-applications/${encodeURIComponent(this.uuid(args.applicationId, "applicationId"))}`,
        this.objectSchema(
          {
            applicationId: uuid("OAuth Application UUID."),
            name: string("Application name.", { minLength: 1, maxLength: 128 }),
            redirectUris: stringArray("OAuth redirect URIs."),
            postLogoutRedirectUris: stringArray("Post-logout redirect URIs."),
          },
          ["applicationId"],
        ),
        (args) =>
          this.pick(args, [
            "name",
            "redirectUris",
            "postLogoutRedirectUris",
          ]),
        true,
      ),
      write(
        "resourceportal_admin_rotate_oauth_application_credentials",
        "Rotate platform OAuth credentials",
        "Rotate credentials for a platform-scoped OAuth application. New credentials may be returned once by the underlying API.",
        "POST",
        (args) =>
          `/api/platform/oauth-applications/${encodeURIComponent(this.uuid(args.applicationId, "applicationId"))}/rotate-credentials`,
        idSchema("applicationId", "OAuth Application UUID."),
        undefined,
        true,
      ),
      write(
        "resourceportal_admin_delete_oauth_application",
        "Delete platform OAuth application",
        "Delete a platform-scoped OAuth application.",
        "DELETE",
        (args) =>
          `/api/platform/oauth-applications/${encodeURIComponent(this.uuid(args.applicationId, "applicationId"))}`,
        idSchema("applicationId", "OAuth Application UUID."),
        undefined,
        true,
      ),

      read(
        "resourceportal_admin_list_service_identities",
        "List platform service identities",
        "List platform-scoped service identities.",
        "/api/platform/service-identities",
      ),
      read(
        "resourceportal_admin_get_service_identity",
        "Get platform service identity",
        "Get one platform-scoped service identity by UUID.",
        (args) =>
          `/api/platform/service-identities/${encodeURIComponent(this.uuid(args.serviceIdentityId, "serviceIdentityId"))}`,
        idSchema("serviceIdentityId", "Service Identity UUID."),
      ),
      write(
        "resourceportal_admin_create_service_identity",
        "Create platform service identity",
        "Create a platform-scoped service identity. Newly issued credentials may be returned once by the underlying API.",
        "POST",
        "/api/platform/service-identities",
        this.objectSchema(
          {
            name: string("Service identity name.", {
              minLength: 1,
              maxLength: 128,
            }),
            description: string("Optional description.", { maxLength: 1000 }),
          },
          ["name"],
        ),
        (args) => this.pick(args, ["name", "description"]),
      ),
      write(
        "resourceportal_admin_update_service_identity",
        "Update platform service identity",
        "Update a platform-scoped service identity.",
        "PATCH",
        (args) =>
          `/api/platform/service-identities/${encodeURIComponent(this.uuid(args.serviceIdentityId, "serviceIdentityId"))}`,
        this.objectSchema(
          {
            serviceIdentityId: uuid("Service Identity UUID."),
            name: string("Service identity name.", {
              minLength: 1,
              maxLength: 128,
            }),
            description: string("Optional description.", { maxLength: 1000 }),
            status: { type: "string", enum: ["Active", "Suspended"] },
          },
          ["serviceIdentityId"],
        ),
        (args) => this.pick(args, ["name", "description", "status"]),
        true,
      ),
      write(
        "resourceportal_admin_rotate_service_identity_credentials",
        "Rotate service identity credentials",
        "Rotate credentials for a platform-scoped service identity. New credentials may be returned once by the underlying API.",
        "POST",
        (args) =>
          `/api/platform/service-identities/${encodeURIComponent(this.uuid(args.serviceIdentityId, "serviceIdentityId"))}/rotate-credentials`,
        idSchema("serviceIdentityId", "Service Identity UUID."),
        undefined,
        true,
      ),
      write(
        "resourceportal_admin_delete_service_identity",
        "Delete platform service identity",
        "Delete a platform-scoped service identity.",
        "DELETE",
        (args) =>
          `/api/platform/service-identities/${encodeURIComponent(this.uuid(args.serviceIdentityId, "serviceIdentityId"))}`,
        idSchema("serviceIdentityId", "Service Identity UUID."),
        undefined,
        true,
      ),

      read(
        "resourceportal_admin_list_bug_reports",
        "List Bug Reports",
        "List platform Bug Reports. Optional filters are applied by Admin MCP after the platform API returns the authorized report list.",
        "/api/platform/bug-reports",
        this.objectSchema({
          priority: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3"],
          },
          resolved: {
            type: "boolean",
            description: "Filter by resolved/open state.",
          },
        }),
        (payload, args) => {
          if (!Array.isArray(payload)) return payload;
          return payload.filter((row) => {
            if (!row || typeof row !== "object") return false;
            const report = row as Record<string, unknown>;
            if (
              args.priority !== undefined &&
              report.priority !== args.priority
            ) {
              return false;
            }
            if (
              args.resolved !== undefined &&
              report.resolved !== args.resolved
            ) {
              return false;
            }
            return true;
          });
        },
      ),
      write(
        "resourceportal_admin_update_bug_report_priority",
        "Update Bug Report priority",
        "Set the platform triage priority for one Bug Report.",
        "PATCH",
        (args) =>
          `/api/platform/bug-reports/${encodeURIComponent(this.uuid(args.reportId, "reportId"))}/priority`,
        this.objectSchema(
          {
            reportId: uuid("Bug Report UUID."),
            priority: {
              type: "string",
              enum: ["P0", "P1", "P2", "P3"],
            },
          },
          ["reportId", "priority"],
        ),
        (args) => ({ priority: this.string(args.priority, "priority") }),
      ),
      write(
        "resourceportal_admin_resolve_bug_report",
        "Resolve Bug Report",
        "Mark one Bug Report resolved and optionally record a resolution note.",
        "PATCH",
        (args) =>
          `/api/platform/bug-reports/${encodeURIComponent(this.uuid(args.reportId, "reportId"))}/resolution`,
        this.objectSchema(
          {
            reportId: uuid("Bug Report UUID."),
            resolutionNote: string(
              "Optional resolution note, normally including the fixed release.",
              { maxLength: 4000 },
            ),
          },
          ["reportId"],
        ),
        (args) => ({
          resolved: true,
          ...(args.resolutionNote !== undefined
            ? { resolutionNote: this.string(args.resolutionNote, "resolutionNote") }
            : {}),
        }),
      ),
      write(
        "resourceportal_admin_reopen_bug_report",
        "Reopen Bug Report",
        "Mark a previously resolved Bug Report open again.",
        "PATCH",
        (args) =>
          `/api/platform/bug-reports/${encodeURIComponent(this.uuid(args.reportId, "reportId"))}/resolution`,
        idSchema("reportId", "Bug Report UUID."),
        () => ({ resolved: false }),
      ),
      this.definition({
        name: "resourceportal_admin_get_bug_report_image",
        title: "Get Bug Report image",
        description:
          "Return the image attachment for one Bug Report as MCP image content. The tool never exposes arbitrary files.",
        inputSchema: idSchema("reportId", "Bug Report UUID."),
        readOnly: true,
        destructive: false,
        idempotent: true,
        execute: (args) => ({
          kind: "image",
          path: `/api/platform/bug-reports/${encodeURIComponent(this.uuid(args.reportId, "reportId"))}/image`,
        }),
      }),
    ];

    return tools;
  }

  private definition(input: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    execute: (args: Record<string, unknown>) => Execution;
  }): AdminToolDefinition {
    const securitySchemes = this.securitySchemes();
    return {
      name: input.name,
      title: input.title,
      description: input.description,
      inputSchema: input.inputSchema,
      outputSchema:
        input.name === "resourceportal_admin_get_bug_report_image"
          ? undefined
          : this.apiOutputSchema(),
      securitySchemes,
      annotations: {
        readOnlyHint: input.readOnly,
        destructiveHint: input.destructive,
        idempotentHint: input.idempotent,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes,
        "openai/toolInvocation/invoking": `${input.title}…`,
        "openai/toolInvocation/invoked": `${input.title} finished`,
      },
      execute: input.execute,
    };
  }

  private balanceMutationSchema(
    uuid: (description: string) => Record<string, unknown>,
    string: (
      description: string,
      extra?: Record<string, unknown>,
    ) => Record<string, unknown>,
    positiveOnly: boolean,
    reasonRequired: boolean,
  ) {
    const required = ["tenantId", "amountCredits"];
    if (reasonRequired) required.push("reason");
    return this.objectSchema(
      {
        tenantId: uuid("Tenant UUID. This identifies the billing account only."),
        amountCredits: string(
          positiveOnly
            ? "Positive credit amount."
            : "Signed non-zero credit amount.",
        ),
        reference: string("Optional external/operator reference."),
        reason: string("Operator reason."),
        sourceTransactionId: uuid("Optional source billing transaction UUID."),
      },
      required,
    );
  }

  private identityProviderSchema(
    string: (
      description: string,
      extra?: Record<string, unknown>,
    ) => Record<string, unknown>,
    stringArray: (description: string) => Record<string, unknown>,
    create: boolean,
    uuid: (description: string) => Record<string, unknown>,
  ) {
    const properties: Record<string, unknown> = {
      ...(create
        ? {}
        : {
            identityProviderId: uuid("Identity Provider UUID."),
          }),
      name: string("Identity provider name.", {
        minLength: 1,
        maxLength: 128,
      }),
      protocol: { type: "string", enum: ["OIDC", "SAML"] },
      issuer: string("OIDC issuer URL.", {
        format: "uri",
        maxLength: 200,
      }),
      metadataUrl: string("SAML metadata URL.", {
        format: "uri",
        maxLength: 200,
      }),
      clientId: string("OIDC client ID.", {
        minLength: 1,
        maxLength: 200,
      }),
      clientSecret: string("Replacement OIDC client secret.", {
        minLength: 1,
        maxLength: 1000,
      }),
      scopes: stringArray("OIDC scopes."),
      usePkce: { type: "boolean" },
      enabled: { type: "boolean" },
    };
    return this.objectSchema(
      properties,
      create ? ["name", "protocol"] : ["identityProviderId"],
    );
  }

  private async executeJsonCall(
    context: McpCallContext,
    toolName: string,
    execution: JsonExecution,
  ) {
    const response = await this.callApi(
      context,
      execution.method,
      execution.path,
      execution.body,
    ).catch(async (error) => {
      await this.recordToolCall(
        context,
        toolName,
        false,
        execution.method,
        execution.path,
      );
      throw error;
    });

    await this.recordToolCall(
      context,
      toolName,
      response.ok,
      execution.method,
      execution.path,
      response.status,
    );

    if (execution.postProcess && response.ok) {
      response.payload = execution.postProcess(response.payload);
    }

    return this.httpToolResult(response);
  }

  private async executeImageCall(
    context: McpCallContext,
    toolName: string,
    path: string,
  ): Promise<CallToolResult> {
    this.assertAdminPath(path);
    const headers = this.forwardedHeaders(context);
    const port = this.config.get<number>("PORT", 3000);
    const response = await fetch(new URL(path, `http://127.0.0.1:${port}`), {
      method: "GET",
      headers,
    }).catch(async (error) => {
      await this.recordToolCall(context, toolName, false, "GET", path);
      throw error;
    });

    if (!response.ok) {
      const text = await response.text();
      let payload: unknown = text;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        // Keep the text payload.
      }
      await this.recordToolCall(
        context,
        toolName,
        false,
        "GET",
        path,
        response.status,
      );
      return this.httpToolResult({
        status: response.status,
        ok: false,
        payload,
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxImageBytes) {
      await this.recordToolCall(
        context,
        toolName,
        false,
        "GET",
        path,
        response.status,
      );
      throw new BadRequestException("Bug Report image exceeds Admin MCP size limit");
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!mimeType?.startsWith("image/")) {
      await this.recordToolCall(
        context,
        toolName,
        false,
        "GET",
        path,
        response.status,
      );
      throw new BadRequestException("Bug Report attachment is not an image");
    }

    await this.recordToolCall(
      context,
      toolName,
      true,
      "GET",
      path,
      response.status,
    );
    return {
      structuredContent: {
        status: response.status,
        ok: true,
        mimeType,
        sizeBytes: bytes.byteLength,
      },
      content: [
        {
          type: "image",
          data: bytes.toString("base64"),
          mimeType,
        },
      ],
    };
  }

  private async callApi(
    context: McpCallContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<AdminApiResult> {
    this.assertAdminPath(path);

    if (body !== undefined) {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > maxToolBodyBytes) {
        throw new BadRequestException(
          "Admin MCP request body exceeds 256 KiB",
        );
      }
    }

    const port = this.config.get<number>("PORT", 3000);
    const headers = this.forwardedHeaders(context);
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(new URL(path, `http://127.0.0.1:${port}`), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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

  private assertAdminPath(path: string) {
    const pathname = path.split("?")[0] ?? path;
    if (
      path.includes("://") ||
      path.startsWith("//") ||
      path.includes("..") ||
      !(
        pathname.startsWith("/api/platform/") ||
        pathname === "/api/platform" ||
        pathname.startsWith("/api/health/") ||
        pathname === "/api/metrics"
      )
    ) {
      throw new BadRequestException(
        "Admin MCP tool attempted to escape the platform API boundary",
      );
    }
    if (pathname.startsWith("/api/tenants/")) {
      throw new BadRequestException(
        "Admin MCP cannot call tenant-scoped ResourcePortal APIs",
      );
    }
  }

  private forwardedHeaders(context: McpCallContext) {
    const headers: Record<string, string> = {
      accept: "application/json, image/*, text/plain;q=0.8",
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
    return headers;
  }

  private async recordToolCall(
    context: McpCallContext,
    toolName: string,
    success: boolean,
    method?: string,
    path?: string,
    statusCode?: number,
  ) {
    if (!context.actor) return;
    await this.audit.recordToolCall({
      actor: context.actor,
      toolName,
      method,
      path,
      statusCode,
      success,
      requestId: this.header(context.request, "x-request-id"),
      correlationId: this.header(context.request, "x-correlation-id"),
    });
  }

  private authenticationRequired(context: McpCallContext): CallToolResult {
    const metadata = adminProtectedResourceMetadataUrl(context.request);
    const challenge = metadata
      ? `Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="Connect a ResourcePortal platform administrator account to use this tool"`
      : 'Bearer error="insufficient_scope", error_description="Connect a ResourcePortal platform administrator account to use this tool"';

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Authentication required. Connect a ResourcePortal platform administrator account and try again.",
        },
      ],
      _meta: {
        "mcp/www_authenticate": [challenge],
      },
    };
  }

  private forbiddenToolResult(message: string): CallToolResult {
    const structuredContent = {
      status: 403,
      ok: false,
      data: {
        message,
        error: "Forbidden",
        statusCode: 403,
      },
    };
    return {
      isError: true,
      structuredContent,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
    };
  }

  private httpToolResult(response: AdminApiResult): CallToolResult {
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

  private objectSchema(
    properties: Record<string, unknown>,
    required: string[] = [],
  ) {
    return {
      $schema: jsonSchemaDialect,
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    };
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
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
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

  private platformAuditPath(
    args: Record<string, unknown>,
    exportMode = false,
  ) {
    const params = new URLSearchParams();
    for (const key of [
      "action",
      "actor",
      "resourceType",
      "resourceId",
      "result",
      "requestId",
      "correlationId",
      "from",
      "to",
      "cursor",
      "limit",
      "format",
    ] as const) {
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== "string" && typeof value !== "number") {
        throw new BadRequestException(`${key} must be a string or number`);
      }
      params.set(key, String(value));
    }
    const query = params.toString();
    return `/api/platform/audit-log${exportMode ? "/export" : ""}${
      query ? `?${query}` : ""
    }`;
  }

  private pick(args: Record<string, unknown>, keys: string[]) {
    return Object.fromEntries(
      keys
        .filter((key) => args[key] !== undefined)
        .map((key) => [key, args[key]]),
    );
  }

  private uuid(value: unknown, key: string) {
    const stringValue = this.string(value, key);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        stringValue,
      )
    ) {
      throw new BadRequestException(`${key} must be a UUID`);
    }
    return stringValue;
  }

  private string(value: unknown, key: string) {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException(`${key} must be a non-empty string`);
    }
    return value.trim();
  }

  private boolean(value: unknown, key: string) {
    if (typeof value !== "boolean") {
      throw new BadRequestException(`${key} must be a boolean`);
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
