import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import type { UpdateNetworkEgressPolicyDto } from "./dto/update-network-egress-policy.dto";
import {
  DEFAULT_BLOCKED_IPV4_CIDRS,
  DEFAULT_BLOCKED_IPV6_CIDRS,
  PLATFORM_EGRESS_POLICY_ID,
} from "./network-egress.constants";
import type { NetworkEgressPolicySnapshot } from "./network-egress.types";

@Injectable()
export class NetworkEgressService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlatformState() {
    const [policy, latestReconciliation] = await Promise.all([
      this.getPolicy(),
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

  async policySnapshot(): Promise<NetworkEgressPolicySnapshot> {
    const policy = await this.getPolicy();
    return {
      version: 2,
      enabled: policy.enabled,
      revision: policy.revision,
      blockedIpv4Cidrs: [...DEFAULT_BLOCKED_IPV4_CIDRS],
      blockedIpv6Cidrs: [...DEFAULT_BLOCKED_IPV6_CIDRS],
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
