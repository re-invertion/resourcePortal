import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateNetworkEgressRuleDto } from "./dto/create-network-egress-rule.dto";
import type { UpdateNetworkEgressPolicyDto } from "./dto/update-network-egress-policy.dto";
import { parseAndNormalizeCidr } from "./network-egress.cidr";
import {
  DEFAULT_BLOCKED_IPV4_CIDRS,
  DEFAULT_BLOCKED_IPV6_CIDRS,
  PLATFORM_EGRESS_POLICY_ID,
} from "./network-egress.constants";
import type {
  EgressProtocol,
  NetworkEgressPolicySnapshot,
} from "./network-egress.types";

@Injectable()
export class NetworkEgressService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlatformState() {
    const [policy, rules, appGroups, latestReconciliation] = await Promise.all([
      this.getPolicy(),
      this.prisma.platformEgressAllowRule.findMany({
        include: {
          appGroup: {
            select: {
              id: true,
              name: true,
              tenant: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [
          { appGroup: { tenant: { name: "asc" } } },
          { appGroup: { name: "asc" } },
          { destinationCidr: "asc" },
        ],
      }),
      this.prisma.appGroup.findMany({
        select: {
          id: true,
          name: true,
          tenant: { select: { id: true, name: true } },
        },
        orderBy: [{ tenant: { name: "asc" } }, { name: "asc" }],
      }),
      this.prisma.workerReconciliationState.findFirst({
        where: { key: "egressPolicy" },
        orderBy: { lastCompletedAt: "desc" },
        select: {
          lastSuccessAt: true,
          lastFailureAt: true,
          lastCompletedAt: true,
          lastResult: true,
          lastError: true,
        },
      }),
    ]);

    return {
      enabled: policy.enabled,
      revision: policy.revision,
      protectedCidrs: [
        ...DEFAULT_BLOCKED_IPV4_CIDRS,
        ...DEFAULT_BLOCKED_IPV6_CIDRS,
      ],
      updatedAt: policy.updatedAt,
      enforcement: latestReconciliation,
      appGroups: appGroups.map((appGroup) => ({
        id: appGroup.id,
        name: appGroup.name,
        tenantId: appGroup.tenant.id,
        tenantName: appGroup.tenant.name,
      })),
      rules: rules.map((rule) => ({
        id: rule.id,
        appGroupId: rule.appGroupId,
        appGroupName: rule.appGroup.name,
        tenantId: rule.appGroup.tenant.id,
        tenantName: rule.appGroup.tenant.name,
        destinationCidr: rule.destinationCidr,
        protocol: rule.protocol,
        port: rule.port === 0 ? null : rule.port,
        description: rule.description,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      })),
    };
  }

  async updatePolicy(
    dto: UpdateNetworkEgressPolicyDto,
    actor: AuthenticatedUser,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const policy = await tx.platformEgressPolicy.upsert({
        where: { id: PLATFORM_EGRESS_POLICY_ID },
        create: {
          id: PLATFORM_EGRESS_POLICY_ID,
          enabled: dto.enabled,
          updatedBy: actor.id,
        },
        update: {
          enabled: dto.enabled,
          revision: { increment: 1 },
          updatedBy: actor.id,
        },
      });
      await this.audit(tx, actor, {
        action: "platform_network_egress.update",
        resourceType: "PlatformEgressPolicy",
        resourceId: policy.id,
        resourceName: "Tenant network egress policy",
        changes: { enabled: policy.enabled, revision: policy.revision },
      });
      return policy;
    });
    return {
      enabled: updated.enabled,
      revision: updated.revision,
      updatedAt: updated.updatedAt,
    };
  }

  async createRule(dto: CreateNetworkEgressRuleDto, actor: AuthenticatedUser) {
    const appGroup = await this.prisma.appGroup.findUnique({
      where: { id: dto.appGroupId },
      select: {
        id: true,
        name: true,
        tenant: { select: { id: true, name: true } },
      },
    });
    if (!appGroup) throw new NotFoundException("App Group not found");

    const destination = parseAndNormalizeCidr(dto.destinationCidr);
    if (!destination) {
      throw new BadRequestException(
        "destinationCidr must be a valid IPv4 or IPv6 address/CIDR",
      );
    }
    const protocol = dto.protocol ?? "any";
    if (protocol === "any" && dto.port !== undefined) {
      throw new BadRequestException(
        "A port can only be specified with tcp or udp protocol",
      );
    }
    const port = dto.port ?? 0;
    const description = dto.description?.trim() || null;

    try {
      const rule = await this.prisma.$transaction(async (tx) => {
        const created = await tx.platformEgressAllowRule.create({
          data: {
            appGroupId: appGroup.id,
            destinationCidr: destination.normalized,
            protocol,
            port,
            description,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        await tx.platformEgressPolicy.upsert({
          where: { id: PLATFORM_EGRESS_POLICY_ID },
          create: {
            id: PLATFORM_EGRESS_POLICY_ID,
            enabled: true,
            revision: 1,
            updatedBy: actor.id,
          },
          update: { revision: { increment: 1 }, updatedBy: actor.id },
        });
        await this.audit(tx, actor, {
          action: "platform_network_egress.rule.create",
          resourceType: "PlatformEgressAllowRule",
          resourceId: created.id,
          resourceName: `${appGroup.name}: ${destination.normalized}`,
          changes: {
            appGroupId: appGroup.id,
            destinationCidr: destination.normalized,
            protocol,
            port: port || null,
          },
        });
        return created;
      });
      return {
        ...rule,
        port: rule.port === 0 ? null : rule.port,
        appGroupName: appGroup.name,
        tenantId: appGroup.tenant.id,
        tenantName: appGroup.tenant.name,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("An identical egress allow rule already exists");
      }
      throw error;
    }
  }

  async deleteRule(ruleId: string, actor: AuthenticatedUser) {
    const existing = await this.prisma.platformEgressAllowRule.findUnique({
      where: { id: ruleId },
      include: {
        appGroup: { select: { id: true, name: true } },
      },
    });
    if (!existing) throw new NotFoundException("Egress allow rule not found");

    await this.prisma.$transaction(async (tx) => {
      await tx.platformEgressAllowRule.delete({ where: { id: ruleId } });
      await tx.platformEgressPolicy.upsert({
        where: { id: PLATFORM_EGRESS_POLICY_ID },
        create: {
          id: PLATFORM_EGRESS_POLICY_ID,
          enabled: true,
          revision: 1,
          updatedBy: actor.id,
        },
        update: { revision: { increment: 1 }, updatedBy: actor.id },
      });
      await this.audit(tx, actor, {
        action: "platform_network_egress.rule.delete",
        resourceType: "PlatformEgressAllowRule",
        resourceId: existing.id,
        resourceName: `${existing.appGroup.name}: ${existing.destinationCidr}`,
        changes: {
          appGroupId: existing.appGroupId,
          destinationCidr: existing.destinationCidr,
          protocol: existing.protocol,
          port: existing.port || null,
        },
      });
    });
    return { deleted: true };
  }

  async policySnapshot(): Promise<NetworkEgressPolicySnapshot> {
    const [policy, rules] = await Promise.all([
      this.getPolicy(),
      this.prisma.platformEgressAllowRule.findMany({
        orderBy: [
          { appGroupId: "asc" },
          { destinationCidr: "asc" },
          { protocol: "asc" },
          { port: "asc" },
        ],
        select: {
          id: true,
          appGroupId: true,
          destinationCidr: true,
          protocol: true,
          port: true,
        },
      }),
    ]);
    return {
      version: 1,
      enabled: policy.enabled,
      revision: policy.revision,
      blockedIpv4Cidrs: [...DEFAULT_BLOCKED_IPV4_CIDRS],
      blockedIpv6Cidrs: [...DEFAULT_BLOCKED_IPV6_CIDRS],
      rules: rules.map((rule) => ({
        ...rule,
        protocol: normalizeProtocol(rule.protocol),
      })),
    };
  }

  private getPolicy() {
    return this.prisma.platformEgressPolicy.upsert({
      where: { id: PLATFORM_EGRESS_POLICY_ID },
      create: {
        id: PLATFORM_EGRESS_POLICY_ID,
        enabled: true,
        revision: 1,
      },
      update: {},
    });
  }

  private audit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    input: {
      action: string;
      resourceType: string;
      resourceId: string;
      resourceName: string;
      changes: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "Platform",
        actor: actor.id,
        actorName: actor.displayName,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        result: "Success",
        correlationId: randomUUID(),
        changes: input.changes,
      },
    });
  }
}

function normalizeProtocol(value: string): EgressProtocol {
  return value === "tcp" || value === "udp" ? value : "any";
}
