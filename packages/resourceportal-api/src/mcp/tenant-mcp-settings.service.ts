import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MembershipStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import {
  TenantMcpAccessMode,
  UpdateTenantMcpSettingsDto,
} from "./dto/update-tenant-mcp-settings.dto";

const defaultAccessMode: TenantMcpAccessMode = "SelectedMembers";

@Injectable()
export class TenantMcpSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly oidc: OidcAuthService,
  ) {}

  async getSettings(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const settings = await this.prisma.tenantMcpSettings.findUnique({
      where: { tenantId },
      include: {
        allowedMembers: {
          include: {
            membership: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    displayName: true,
                    status: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    return {
      enabled: settings?.enabled ?? false,
      accessMode: this.accessMode(settings?.accessMode),
      allowedMembershipIds: settings?.allowedMembers.map((row) => row.membershipId) ?? [],
      allowedMembers:
        settings?.allowedMembers.map((row) => ({
          membershipId: row.membershipId,
          userId: row.membership.userId,
          status: row.membership.status,
          email: row.membership.user.email,
          displayName: row.membership.user.displayName,
        })) ?? [],
      updatedAt: settings?.updatedAt ?? null,
      oauth: await this.oauthStatus(),
    };
  }

  async updateSettings(
    tenantId: string,
    dto: UpdateTenantMcpSettingsDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const current = await this.prisma.tenantMcpSettings.findUnique({
      where: { tenantId },
      include: { allowedMembers: true },
    });
    const enabled = dto.enabled ?? current?.enabled ?? false;
    const accessMode = dto.accessMode ?? this.accessMode(current?.accessMode);
    const previousIds = current?.allowedMembers.map((row) => row.membershipId) ?? [];
    const allowedMembershipIds =
      accessMode === "AllMembers" ? [] : dto.allowedMembershipIds ?? previousIds;

    await this.validateMemberships(tenantId, allowedMembershipIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantMcpSettings.upsert({
        where: { tenantId },
        create: {
          tenantId,
          enabled,
          accessMode,
          updatedBy: actor.id,
        },
        update: {
          enabled,
          accessMode,
          updatedBy: actor.id,
        },
      });

      await tx.tenantMcpMemberAccess.deleteMany({ where: { tenantId } });
      if (allowedMembershipIds.length > 0) {
        await tx.tenantMcpMemberAccess.createMany({
          data: allowedMembershipIds.map((membershipId) => ({
            tenantId,
            membershipId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant.mcp.settings.update",
          resourceType: "TenantMcpSettings",
          resourceId: tenantId,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            enabled,
            accessMode,
            allowedMembershipIds,
          },
        },
      });
    });

    return this.getSettings(tenantId);
  }

  async assertMcpEnabled(tenantId: string) {
    const settings = await this.prisma.tenantMcpSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    if (!settings?.enabled) {
      throw new ForbiddenException("Tenant MCP is disabled");
    }
  }

  async assertUserCanUseMcp(tenantId: string, userId: string) {
    const settings = await this.prisma.tenantMcpSettings.findUnique({
      where: { tenantId },
      include: {
        allowedMembers: {
          where: { membership: { userId } },
          select: { membershipId: true },
        },
      },
    });

    if (!settings?.enabled) {
      throw new ForbiddenException("Tenant MCP is disabled");
    }

    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true, status: true },
    });
    if (!membership || membership.status !== MembershipStatus.Active) {
      throw new ForbiddenException("Active tenant membership is required for MCP");
    }

    const mode = this.accessMode(settings.accessMode);
    if (mode === "SelectedMembers" && settings.allowedMembers.length === 0) {
      throw new ForbiddenException("This tenant member is not allowed to use MCP");
    }

    return membership;
  }

  async recordToolCall(input: {
    tenantId: string;
    actor: AuthenticatedUser;
    toolName: string;
    method?: string;
    path?: string;
    statusCode?: number;
    success: boolean;
    requestId?: string;
    correlationId?: string;
  }) {
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: input.tenantId },
        select: { name: true },
      });
      if (!tenant) return;
      await this.prisma.auditLogEntry.create({
        data: {
          tenantId: input.tenantId,
          tenantName: tenant.name,
          actor: input.actor.id,
          actorName: input.actor.displayName,
          action: "tenant.mcp.tool.call",
          resourceType: "TenantMcp",
          resourceId: input.tenantId,
          result: input.success ? "Success" : "Failure",
          errorCode: input.success ? null : "MCP_TOOL_CALL_FAILED",
          requestId: input.requestId,
          correlationId: input.correlationId ?? randomUUID(),
          changes: {
            toolName: input.toolName,
            method: input.method ?? null,
            path: input.path ?? null,
            statusCode: input.statusCode ?? null,
          },
        },
      });
    } catch {
      // Audit logging must not change the MCP call result.
    }
  }

  private async validateMemberships(tenantId: string, membershipIds: string[]) {
    if (membershipIds.length === 0) return;
    const count = await this.prisma.tenantMembership.count({
      where: { tenantId, id: { in: membershipIds } },
    });
    if (count !== membershipIds.length) {
      throw new BadRequestException("Every allowed MCP member must belong to this tenant");
    }
  }

  private async ensureTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  private accessMode(value: string | undefined): TenantMcpAccessMode {
    return value === "AllMembers" ? "AllMembers" : defaultAccessMode;
  }

  private async oauthStatus() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "") ?? null;
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID") ?? null;
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID") ?? null;
    const scopes = [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...(projectId ? [`urn:zitadel:iam:org:project:id:${projectId}:aud`] : []),
      ...(organizationId ? [`urn:zitadel:iam:org:id:${organizationId}`] : []),
    ];

    try {
      const discovery = await this.oidc.getDiscovery();
      return {
        issuer,
        scopes,
        discoveryAvailable: true,
        dynamicClientRegistrationAvailable: Boolean(discovery.registrationEndpoint),
        openAiReady: Boolean(discovery.registrationEndpoint),
        transport: "Streamable HTTP",
        protocol: "MCP 2026-07-28 with 2025-era compatibility",
      };
    } catch {
      return {
        issuer,
        scopes,
        discoveryAvailable: false,
        dynamicClientRegistrationAvailable: false,
        openAiReady: false,
        transport: "Streamable HTTP",
        protocol: "MCP 2026-07-28 with 2025-era compatibility",
      };
    }
  }
}
