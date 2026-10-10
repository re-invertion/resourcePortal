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
    private readonly prisma: PrismaService,
  ) {}

  async createHttpHandler(context: McpCallContext) {
    const { Server, createMcpHandler } =
      await import("@modelcontextprotocol/server");

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

        server.setRequestHandler("tools/list", async () => {
          return {
            tools: await this.tools(context),
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
      case "resourceportal_list_bug_reports":
        return this.callBugReports(context, name, args);
      case "resourceportal_manage_app_groups":
        return this.callManagedOperation(context, name, "app-groups", args);
      case "resourceportal_manage_app_group_resources":
        return this.callManagedOperation(context, name, "app-group-resources", args);
      case "resourceportal_manage_single_apps":
        return this.callManagedOperation(context, name, "single-apps", args);
      case "resourceportal_manage_volumes":
        return this.callManagedOperation(context, name, "volumes", args);
      case "resourceportal_manage_registries":
        return this.callManagedOperation(context, name, "registries", args);
      case "resourceportal_manage_domains":
        return this.callManagedOperation(context, name, "domains", args);
      case "resourceportal_manage_networking":
        return this.callManagedOperation(context, name, "networking", args);
      case "resourceportal_manage_access":
        return this.callManagedOperation(context, name, "access", args);
      case "resourceportal_manage_identity":
        return this.callManagedOperation(context, name, "identity", args);
      case "resourceportal_manage_resource_bot":
        return this.callManagedOperation(context, name, "resource-bot", args);
      case "resourceportal_manage_operations":
        return this.callManagedOperation(context, name, "operations", args);
      case "resourceportal_manage_mcp_settings":
        return this.callManagedOperation(context, name, "mcp-settings", args);
      case "resourceportal_search_and_audit":
        return this.callManagedOperation(context, name, "search-audit", args);

      case "resourceportal_tenant_endpoints":
        await this.recordToolCall(context, name, true);
        return this.toolResult(this.endpointCatalog());

      case "resourceportal_tenant_api":
        return this.callCompatibilityTool(context, name, args);

      default:
        return {
          isError: true,
          content: [
            { type: "text", text: `Unknown ResourcePortal tool: ${name}` },
          ],
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

  private async callBugReports(
    context: McpCallContext,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    if (!(await isPlatformAdminUser(this.config, this.prisma, context.actor))) {
      await this.recordToolCall(context, toolName, false);
      return this.forbiddenToolResult(
        "Platform administrator access is required",
      );
    }

    const priority =
      args.priority === undefined
        ? undefined
        : this.bugReportPriority(args.priority);
    const response = await this.executePlatformApiCall(
      context,
      toolName,
      "GET",
      "/bug-reports",
    );

    const structured = response.structuredContent as
      { status: number; ok: boolean; data: unknown } | undefined;
    if (priority && structured && Array.isArray(structured.data)) {
      const filtered = structured.data.filter(
        (report: unknown) =>
          typeof report === "object" &&
          report !== null &&
          "priority" in report &&
          report.priority === priority,
      );
      return this.toolResult({
        status: structured.status,
        ok: structured.ok,
        data: filtered,
      });
    }

    return response;
  }

  private async callManagedOperation(
    context: McpCallContext,
    toolName: string,
    area: string,
    args: Record<string, unknown>,
  ) {
    const operation = this.string(args.operation, "operation must be provided");
    const body = args.body;
    const uuid = (key: string) => this.uuid(args[key], key);
    let method = "GET";
    let path = "";

    switch (`${area}:${operation}`) {
      case "app-groups:list": path = "/app-groups"; break;
      case "app-groups:create": method = "POST"; path = "/app-groups"; break;
      case "app-groups:get": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}`; break;
      case "app-groups:stack_preview": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/stack-preview`; break;
      case "app-groups:delete": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}`; break;
      case "app-groups:deploy": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/deploy`; break;
      case "app-groups:discard_changes": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/discard-changes`; break;
      case "app-groups:start": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/runtime/start`; break;
      case "app-groups:stop": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/runtime/stop`; break;
      case "app-groups:restart": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/runtime/restart`; break;
      case "app-groups:import_validate": method = "POST"; path = "/app-groups/import/validate"; break;
      case "app-groups:import_apply": method = "POST"; path = "/app-groups/import/apply"; break;
      case "app-groups:list_deployments": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/deployments`; break;
      case "app-groups:get_deployment": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/deployments/${encodeURIComponent(uuid("deploymentId"))}`; break;
      case "app-groups:deployment_events": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/deployments/${encodeURIComponent(uuid("deploymentId"))}/events`; break;
      case "app-groups:rollback_deployment": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/deployments/${encodeURIComponent(uuid("deploymentId"))}/rollback`; break;

      case "app-group-resources:list": {
        const kind = this.resourceCollection(args.resourceType);
        path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/${kind}`;
        break;
      }
      case "app-group-resources:create": {
        const kind = this.resourceCollection(args.resourceType);
        method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/${kind}`;
        break;
      }
      case "app-group-resources:update": {
        const kind = this.resourceCollection(args.resourceType);
        method = "PATCH"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/${kind}/${encodeURIComponent(uuid("resourceId"))}`;
        break;
      }
      case "app-group-resources:delete": {
        const kind = this.resourceCollection(args.resourceType);
        method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/${kind}/${encodeURIComponent(uuid("resourceId"))}`;
        break;
      }

      case "single-apps:list": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps`; break;
      case "single-apps:create": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps`; break;
      case "single-apps:update": method = "PATCH"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}`; break;
      case "single-apps:delete": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}`; break;
      case "single-apps:start": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/runtime/start`; break;
      case "single-apps:stop": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/runtime/stop`; break;
      case "single-apps:restart": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/runtime/restart`; break;
      case "single-apps:get_runtime_config": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/runtime-config`; break;
      case "single-apps:update_runtime_config": method = "PATCH"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/runtime-config`; break;
      case "single-apps:list_http_endpoints": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/http-endpoints`; break;
      case "single-apps:get_http_endpoint": path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/http-endpoints/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:create_http_endpoint": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/http-endpoints`; break;
      case "single-apps:update_http_endpoint": method = "PATCH"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/http-endpoints/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:delete_http_endpoint": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/http-endpoints/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:attach_variable": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/variable-attachments`; break;
      case "single-apps:detach_variable": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/variable-attachments/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:attach_secret": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/secret-attachments`; break;
      case "single-apps:detach_secret": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/secret-attachments/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:attach_config": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/config-attachments`; break;
      case "single-apps:detach_config": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/config-attachments/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "single-apps:attach_volume": method = "POST"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/volume-attachments`; break;
      case "single-apps:detach_volume": method = "DELETE"; path = `/app-groups/${encodeURIComponent(uuid("appGroupId"))}/single-apps/${encodeURIComponent(uuid("singleAppId"))}/volume-attachments/${encodeURIComponent(uuid("resourceId"))}`; break;

      case "volumes:list": path = "/volumes"; break;
      case "volumes:create": method = "POST"; path = "/volumes"; break;
      case "volumes:get": path = `/volumes/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "volumes:resize": method = "PATCH"; path = `/volumes/${encodeURIComponent(uuid("resourceId"))}/resize`; break;
      case "volumes:delete": method = "DELETE"; path = `/volumes/${encodeURIComponent(uuid("resourceId"))}`; break;

      case "registries:list": path = "/registries"; break;
      case "registries:create": method = "POST"; path = "/registries"; break;
      case "registries:get": path = `/registries/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "registries:update": method = "PATCH"; path = `/registries/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "registries:delete": method = "DELETE"; path = `/registries/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "registries:validate": method = "POST"; path = `/registries/${encodeURIComponent(uuid("resourceId"))}/validate`; break;
      case "registries:search_public": {
        const query = this.string(args.query, "query must be provided");
        path = `/registries/public-images/search?query=${encodeURIComponent(query)}`;
        break;
      }

      case "domains:list": path = "/domains"; break;
      case "domains:create": method = "POST"; path = "/domains"; break;
      case "domains:get": path = `/domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:update": method = "PATCH"; path = `/domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:delete": method = "DELETE"; path = `/domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:validate": method = "POST"; path = `/domains/${encodeURIComponent(uuid("resourceId"))}/validate`; break;
      case "domains:capabilities": path = "/domains/capabilities"; break;
      case "domains:list_root_domains": path = "/domains/custom-root-domains"; break;
      case "domains:create_root_domain": method = "POST"; path = "/domains/custom-root-domains"; break;
      case "domains:get_root_domain": path = `/domains/custom-root-domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:update_root_domain": method = "PATCH"; path = `/domains/custom-root-domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:validate_root_domain": method = "POST"; path = `/domains/custom-root-domains/${encodeURIComponent(uuid("resourceId"))}/validate`; break;
      case "domains:delete_root_domain": method = "DELETE"; path = `/domains/custom-root-domains/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "domains:cloudflare_status": path = "/domains/cloudflare/status"; break;
      case "domains:cloudflare_authorize": method = "POST"; path = "/domains/cloudflare/authorize"; break;
      case "domains:cloudflare_zones": path = "/domains/cloudflare/zones"; break;
      case "domains:cloudflare_create_root_domain": method = "POST"; path = "/domains/cloudflare/custom-root-domains"; break;
      case "domains:cloudflare_disconnect": method = "DELETE"; path = "/domains/cloudflare/connection"; break;

      case "networking:topology": path = "/networking/topology"; break;
      case "networking:list_networks": path = "/networking/networks"; break;
      case "networking:create_network": method = "POST"; path = "/networking/networks"; break;
      case "networking:update_network": method = "PATCH"; path = `/networking/networks/${encodeURIComponent(uuid("networkId"))}`; break;
      case "networking:delete_network": method = "DELETE"; path = `/networking/networks/${encodeURIComponent(uuid("networkId"))}`; break;
      case "networking:attach_app": method = "POST"; path = `/networking/networks/${encodeURIComponent(uuid("networkId"))}/attachments`; break;
      case "networking:detach_app": method = "DELETE"; path = `/networking/networks/${encodeURIComponent(uuid("networkId"))}/attachments/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "networking:list_gates": path = "/networking/gates"; break;
      case "networking:create_gate": method = "POST"; path = "/networking/gates"; break;
      case "networking:create_gate_enrollment": method = "POST"; path = `/networking/gates/${encodeURIComponent(uuid("gateId"))}/enrollment`; break;
      case "networking:update_gate_routing": method = "PATCH"; path = `/networking/gates/${encodeURIComponent(uuid("gateId"))}/routing`; break;
      case "networking:connect_gate_network": method = "POST"; path = `/networking/gates/${encodeURIComponent(uuid("gateId"))}/networks`; break;
      case "networking:disconnect_gate_network": method = "DELETE"; path = `/networking/gates/${encodeURIComponent(uuid("gateId"))}/networks/${encodeURIComponent(uuid("networkId"))}`; break;
      case "networking:delete_gate": method = "DELETE"; path = `/networking/gates/${encodeURIComponent(uuid("gateId"))}`; break;

      case "access:get_tenant": path = ""; break;
      case "access:get_billing": path = "/billing"; break;
      case "access:list_transactions": path = "/billing/transactions"; break;
      case "access:list_usage_records": path = "/billing/usage-records"; break;
      case "access:get_usage_series": path = "/billing/usage-series"; break;
      case "access:get_usage_summary": path = "/billing/usage-summary"; break;
      case "access:redeem_voucher": method = "POST"; path = "/billing/vouchers/redeem"; break;
      case "access:get_quota": path = "/quota"; break;
      case "access:update_quota": method = "PATCH"; path = "/quota"; break;
      case "access:get_auth_policy": path = "/auth-policy"; break;
      case "access:update_auth_policy": method = "PATCH"; path = "/auth-policy"; break;
      case "access:list_roles": path = "/roles"; break;
      case "access:list_memberships": path = "/memberships"; break;
      case "access:create_membership": method = "POST"; path = "/memberships"; break;
      case "access:update_membership": method = "PATCH"; path = `/memberships/${encodeURIComponent(uuid("membershipId"))}`; break;
      case "access:delete_membership": method = "DELETE"; path = `/memberships/${encodeURIComponent(uuid("membershipId"))}`; break;
      case "access:list_invitations": path = "/invitations"; break;
      case "access:create_invitation": method = "POST"; path = "/invitations"; break;
      case "access:resend_invitation": method = "POST"; path = `/invitations/${encodeURIComponent(uuid("invitationId"))}/resend`; break;
      case "access:delete_invitation": method = "DELETE"; path = `/invitations/${encodeURIComponent(uuid("invitationId"))}`; break;
      case "access:list_groups": path = "/groups"; break;
      case "access:create_group": method = "POST"; path = "/groups"; break;
      case "access:update_group": method = "PATCH"; path = `/groups/${encodeURIComponent(uuid("groupId"))}`; break;
      case "access:delete_group": method = "DELETE"; path = `/groups/${encodeURIComponent(uuid("groupId"))}`; break;
      case "access:add_group_member": method = "POST"; path = `/groups/${encodeURIComponent(uuid("groupId"))}/members`; break;
      case "access:remove_group_member": method = "DELETE"; path = `/groups/${encodeURIComponent(uuid("groupId"))}/members/${encodeURIComponent(uuid("membershipId"))}`; break;
      case "access:add_group_role": method = "POST"; path = `/groups/${encodeURIComponent(uuid("groupId"))}/roles`; break;
      case "access:remove_group_role": method = "DELETE"; path = `/groups/${encodeURIComponent(uuid("groupId"))}/roles/${encodeURIComponent(uuid("roleId"))}`; break;

      case "identity:list_identity_providers": path = "/identity-providers"; break;
      case "identity:get_identity_provider": path = `/identity-providers/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:create_identity_provider": method = "POST"; path = "/identity-providers"; break;
      case "identity:update_identity_provider": method = "PATCH"; path = `/identity-providers/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:delete_identity_provider": method = "DELETE"; path = `/identity-providers/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:list_oauth_applications": path = "/oauth-applications"; break;
      case "identity:get_oauth_application": path = `/oauth-applications/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:create_oauth_application": method = "POST"; path = "/oauth-applications"; break;
      case "identity:update_oauth_application": method = "PATCH"; path = `/oauth-applications/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:rotate_oauth_application": method = "POST"; path = `/oauth-applications/${encodeURIComponent(uuid("resourceId"))}/rotate-credentials`; break;
      case "identity:delete_oauth_application": method = "DELETE"; path = `/oauth-applications/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:list_service_identities": path = "/service-identities"; break;
      case "identity:get_service_identity": path = `/service-identities/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:create_service_identity": method = "POST"; path = "/service-identities"; break;
      case "identity:update_service_identity": method = "PATCH"; path = `/service-identities/${encodeURIComponent(uuid("resourceId"))}`; break;
      case "identity:rotate_service_identity": method = "POST"; path = `/service-identities/${encodeURIComponent(uuid("resourceId"))}/rotate-credentials`; break;
      case "identity:delete_service_identity": method = "DELETE"; path = `/service-identities/${encodeURIComponent(uuid("resourceId"))}`; break;

      case "resource-bot:get_settings": path = "/resource-bot/settings"; break;
      case "resource-bot:update_settings": method = "PATCH"; path = "/resource-bot/settings"; break;
      case "resource-bot:get_status": path = "/resource-bot/status"; break;
      case "resource-bot:send_message": method = "POST"; path = "/resource-bot/messages"; break;
      case "resource-bot:get_usage": path = "/resource-bot/usage"; break;

      case "operations:list": path = "/operations"; break;
      case "operations:get": path = `/operations/${encodeURIComponent(uuid("operationId"))}`; break;
      case "operations:events": path = `/operations/${encodeURIComponent(uuid("operationId"))}/events`; break;
      case "operations:retry": method = "POST"; path = `/operations/${encodeURIComponent(uuid("operationId"))}/retry`; break;

      case "mcp-settings:get": path = "/mcp-settings"; break;
      case "mcp-settings:update": method = "PATCH"; path = "/mcp-settings"; break;

      case "search-audit:search": {
        const query = this.string(args.query, "query must be provided");
        const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? `&limit=${Math.min(args.limit, 100)}` : "";
        path = `/search?q=${encodeURIComponent(query)}${limit}`;
        break;
      }
      case "search-audit:list_audit": path = "/audit-log"; break;
      case "search-audit:export_audit": path = "/audit-log/export"; break;
      default: throw new BadRequestException(`Unsupported ${area} operation: ${operation}`);
    }

    return this.executeTenantApiCall(context, toolName, method, path, body);
  }

  private resourceCollection(value: unknown) {
    const kind = this.string(value, "resourceType must be variable, secret, or config");
    if (kind === "variable") return "variables";
    if (kind === "secret") return "secrets";
    if (kind === "config") return "configs";
    throw new BadRequestException("resourceType must be variable, secret, or config");
  }

  private async callCompatibilityTool(
    context: McpCallContext,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    const method = this.string(
      args.method ?? "GET",
      "method must be a string",
    ).toUpperCase();
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
    return this.executeTenantApiCall(context, toolName, method, path, body);
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

  private async executePlatformApiCall(
    context: McpCallContext,
    toolName: string,
    method: string,
    path: string,
  ) {
    let statusCode: number | undefined;
    const auditPath = `/platform${path}`;
    try {
      const response = await this.callPlatformApi(context, method, path);
      statusCode = response.status;
      await this.settings.recordToolCall({
        tenantId: context.tenantId,
        actor: context.actor!,
        toolName,
        method,
        path: auditPath,
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
        path: auditPath,
        statusCode,
        success: false,
        requestId: this.header(context.request, "x-request-id"),
        correlationId: this.header(context.request, "x-correlation-id"),
      });
      throw error;
    }
  }

  private async callPlatformApi(
    context: McpCallContext,
    method: string,
    requestedPath: string,
  ): Promise<TenantApiResult> {
    const normalizedPath = requestedPath.startsWith("/")
      ? requestedPath
      : `/${requestedPath}`;
    if (
      normalizedPath.includes("://") ||
      normalizedPath.startsWith("//") ||
      normalizedPath.includes("..")
    ) {
      throw new BadRequestException(
        "path must be relative to the platform API",
      );
    }

    const port = this.config.get<number>("PORT", 3000);
    const platformRoot = "/api/platform";
    const target = new URL(
      `${platformRoot}${normalizedPath}`,
      `http://127.0.0.1:${port}`,
    );
    if (!target.pathname.startsWith(`${platformRoot}/`)) {
      throw new BadRequestException("path escapes the platform API boundary");
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

    const response = await fetch(target, { method, headers, signal: AbortSignal.timeout(15_000) });
    const payload = await this.boundedApiPayload(response);

    return {
      status: response.status,
      ok: response.ok,
      payload,
    };
  }

  private async boundedApiPayload(response: Response): Promise<unknown> {
    if (!response.body) return null;
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxToolResponseBytes - size;
        if (value.byteLength > remaining) {
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (truncated) return `${text}\n...[response truncated at 1 MiB]`;
    if (!text) return null;
    try { return JSON.parse(text) as unknown; } catch { return text; }
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
    if (normalizedPath.includes("://") || normalizedPath.startsWith("//")) {
      throw new BadRequestException("path must be relative to this tenant API");
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
      throw new BadRequestException("path escapes the tenant API boundary");
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
      signal: AbortSignal.timeout(15_000),
      body:
        body !== undefined && method !== "GET"
          ? JSON.stringify(body)
          : undefined,
    });
    const payload = await this.boundedApiPayload(response);

    return {
      status: response.status,
      ok: response.ok,
      payload,
    };
  }

  async catalog(context: McpCallContext) {
    return (await this.tools(context)).map(({ name, title, description }) => ({ name, title, description }));
  }

  private async tools(context: McpCallContext): Promise<ToolDescriptor[]> {
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

    const managedTool = (
      name: string,
      title: string,
      description: string,
      operations: string[],
    ): ToolDescriptor => ({
      name,
      title,
      description,
      inputSchema: this.objectSchema(
        {
          operation: { type: "string", enum: operations },
          appGroupId: { type: "string", format: "uuid" },
          singleAppId: { type: "string", format: "uuid" },
          deploymentId: { type: "string", format: "uuid" },
          resourceId: { type: "string", format: "uuid" },
          networkId: { type: "string", format: "uuid" },
          gateId: { type: "string", format: "uuid" },
          membershipId: { type: "string", format: "uuid" },
          invitationId: { type: "string", format: "uuid" },
          groupId: { type: "string", format: "uuid" },
          roleId: { type: "string", format: "uuid" },
          operationId: { type: "string", format: "uuid" },
          resourceType: { type: "string", enum: ["variable", "secret", "config"] },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          body: { type: "object", additionalProperties: true },
        },
        ["operation"],
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
        "openai/toolInvocation/invoking": `${title}…`,
        "openai/toolInvocation/invoked": `${title} finished`,
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
      managedTool(
        "resourceportal_manage_app_groups",
        "Manage App Groups",
        "Create, inspect, deploy, control, import, discard or delete App Groups and deployment history using ResourcePortal RBAC.",
        ["list", "create", "get", "stack_preview", "delete", "deploy", "discard_changes", "start", "stop", "restart", "import_validate", "import_apply", "list_deployments", "get_deployment", "deployment_events", "rollback_deployment"],
      ),
      managedTool(
        "resourceportal_manage_app_group_resources",
        "Manage App Group resources",
        "List, create, update or delete App Group variables, secrets and configs.",
        ["list", "create", "update", "delete"],
      ),
      managedTool(
        "resourceportal_manage_single_apps",
        "Manage applications",
        "Create, update, delete and control Single Apps, runtime config, HTTP endpoints and resource attachments inside an App Group.",
        ["list", "create", "update", "delete", "start", "stop", "restart", "get_runtime_config", "update_runtime_config", "list_http_endpoints", "get_http_endpoint", "create_http_endpoint", "update_http_endpoint", "delete_http_endpoint", "attach_variable", "detach_variable", "attach_secret", "detach_secret", "attach_config", "detach_config", "attach_volume", "detach_volume"],
      ),
      managedTool(
        "resourceportal_manage_volumes",
        "Manage volumes",
        "List, create, inspect, resize or delete tenant volumes.",
        ["list", "create", "get", "resize", "delete"],
      ),
      managedTool(
        "resourceportal_manage_registries",
        "Manage registries",
        "List, create, inspect, update, validate or delete registries, and search public images.",
        ["list", "create", "get", "update", "delete", "validate", "search_public"],
      ),
      managedTool(
        "resourceportal_manage_domains",
        "Manage domains",
        "Manage tenant domains, custom root domains and Cloudflare connection operations.",
        ["list", "create", "get", "update", "delete", "validate", "capabilities", "list_root_domains", "create_root_domain", "get_root_domain", "update_root_domain", "validate_root_domain", "delete_root_domain", "cloudflare_status", "cloudflare_authorize", "cloudflare_zones", "cloudflare_create_root_domain", "cloudflare_disconnect"],
      ),
      managedTool(
        "resourceportal_manage_networking",
        "Manage networking",
        "Inspect topology and manage Networks, application attachments and ResourcePortalGate routing operations.",
        ["topology", "list_networks", "create_network", "update_network", "delete_network", "attach_app", "detach_app", "list_gates", "create_gate", "create_gate_enrollment", "update_gate_routing", "connect_gate_network", "disconnect_gate_network", "delete_gate"],
      ),
      managedTool(
        "resourceportal_manage_access",
        "Manage tenant access and billing",
        "Read billing/quota/auth policy and manage memberships, invitations, groups, group members and group roles.",
        ["get_tenant", "get_billing", "list_transactions", "list_usage_records", "get_usage_series", "get_usage_summary", "redeem_voucher", "get_quota", "update_quota", "get_auth_policy", "update_auth_policy", "list_roles", "list_memberships", "create_membership", "update_membership", "delete_membership", "list_invitations", "create_invitation", "resend_invitation", "delete_invitation", "list_groups", "create_group", "update_group", "delete_group", "add_group_member", "remove_group_member", "add_group_role", "remove_group_role"],
      ),
      managedTool(
        "resourceportal_manage_identity",
        "Manage tenant identity",
        "Manage tenant identity providers, OAuth applications and service identities including credential rotation.",
        ["list_identity_providers", "get_identity_provider", "create_identity_provider", "update_identity_provider", "delete_identity_provider", "list_oauth_applications", "get_oauth_application", "create_oauth_application", "update_oauth_application", "rotate_oauth_application", "delete_oauth_application", "list_service_identities", "get_service_identity", "create_service_identity", "update_service_identity", "rotate_service_identity", "delete_service_identity"],
      ),
      managedTool(
        "resourceportal_manage_resource_bot",
        "Manage ResourceBot",
        "Read or update tenant ResourceBot settings, inspect status and usage, or send a ResourceBot message.",
        ["get_settings", "update_settings", "get_status", "send_message", "get_usage"],
      ),
      managedTool(
        "resourceportal_manage_operations",
        "Manage operations",
        "List or inspect tenant operations and events, and retry an operation when the connected user is permitted.",
        ["list", "get", "events", "retry"],
      ),
      managedTool(
        "resourceportal_manage_mcp_settings",
        "Manage MCP settings",
        "Read or update the tenant MCP enablement and allow-list settings. This can affect future MCP access.",
        ["get", "update"],
      ),
      managedTool(
        "resourceportal_search_and_audit",
        "Search and audit",
        "Search tenant resources or read/export the tenant audit log using the connected user's permissions.",
        ["search", "list_audit", "export_audit"],
      ),
      ...(context.actor &&
      context.hasInteractiveCredential &&
      (await isPlatformAdminUser(this.config, this.prisma, context.actor))
        ? [
            readTool(
              "resourceportal_list_bug_reports",
              "List Bug Reports",
              "List platform Bug Reports. This tool is available only to ResourcePortal platform administrators.",
              this.objectSchema({
                priority: {
                  type: "string",
                  enum: ["Unassigned", "P0", "P1", "P2", "P3"],
                  description:
                    "Optional priority filter. Omit it to return all platform bug reports.",
                },
              }),
            ),
          ]
        : []),
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
          "openai/toolInvocation/invoking":
            "Calling ResourcePortal tenant API…",
          "openai/toolInvocation/invoked":
            "ResourcePortal tenant API call finished",
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
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
    return [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...(projectId ? [`urn:zitadel:iam:org:project:id:${projectId}:aud`] : []),
      ...(organizationId ? [`urn:zitadel:iam:org:id:${organizationId}`] : []),
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
        {
          path: "/volumes",
          methods: ["GET", "POST"],
          purpose: "Tenant volumes",
        },
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
      rule: "Every call uses the connected user's existing ResourcePortal tenant RBAC. A 403 means that user's ResourcePortal permissions do not allow the operation.",
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

  private forbiddenToolResult(message: string): CallToolResult {
    const structuredContent = {
      status: 403,
      ok: false,
      data: { message, error: "Forbidden", statusCode: 403 },
    };
    return {
      isError: true,
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    };
  }

  private bugReportPriority(value: unknown) {
    const priority = this.string(
      value,
      "priority must be Unassigned, P0, P1, P2, or P3",
    );
    if (!["Unassigned", "P0", "P1", "P2", "P3"].includes(priority)) {
      throw new BadRequestException(
        "priority must be Unassigned, P0, P1, P2, or P3",
      );
    }
    return priority;
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
