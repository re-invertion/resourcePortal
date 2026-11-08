import {
  ConflictException, ForbiddenException, Injectable, NotFoundException,
} from "@nestjs/common";
import { MembershipStatus, UserStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AppConsumersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    const consumers = await this.prisma.tenantAppConsumer.findMany({
      where: { tenantId },
      include: {
        membership: {
          include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
        },
        grants: {
          include: { application: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    // Never return ZITADEL grant IDs, external subject, client secrets, OAuth
    // credentials, session tokens or any tenant resource inventories here.
    return consumers.map((consumer) => ({
      membershipId: consumer.membershipId,
      status: consumer.membership.status,
      user: consumer.membership.user,
      createdAt: consumer.createdAt,
      grants: consumer.grants.map((grant) => ({
        applicationId: grant.oauthApplicationId,
        applicationName: grant.application.name,
        enabled: grant.enabled,
        updatedAt: grant.updatedAt,
      })),
    }));
  }

  async grant(
    tenantId: string,
    membershipId: string,
    applicationId: string,
    actor: AuthenticatedUser,
  ) {
    const consumer = await this.requireActiveConsumer(tenantId, membershipId);
    if (actor.id === consumer.membership.userId) {
      throw new ForbiddenException("Consumers cannot modify their own grants");
    }
    const application = await this.prisma.oAuthApplication.findFirst({
      where: { id: applicationId, tenantId },
      select: { id: true, name: true },
    });
    if (!application) throw new NotFoundException("OAuthApplication not found in tenant");

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.tenantAppClientGrant.upsert({
        where: { membershipId_oauthApplicationId: { membershipId, oauthApplicationId: applicationId } },
        create: { membershipId, tenantId, oauthApplicationId: applicationId,
          createdBy: actor.id, updatedBy: actor.id, enabled: true },
        update: { enabled: true, updatedBy: actor.id },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId, tenantName: consumer.tenant.name, actor: actor.id, actorName: actor.displayName,
          action: "app_consumer.grant", resourceType: "OAuthApplication",
          resourceId: applicationId, resourceName: application.name, result: "Success",
          correlationId: randomUUID(),
          changes: { membershipId, applicationId, enabled: true },
        },
      });
      return { id: record.id, applicationId, enabled: record.enabled };
    });
  }

  async revoke(
    tenantId: string,
    membershipId: string,
    applicationId: string,
    actor: AuthenticatedUser,
  ) {
    const consumer = await this.requireActiveConsumer(tenantId, membershipId);
    if (actor.id === consumer.membership.userId) {
      throw new ForbiddenException("Consumers cannot modify their own grants");
    }
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.tenantAppClientGrant.updateMany({
        where: { tenantId, membershipId, oauthApplicationId: applicationId, enabled: true },
        data: { enabled: false, updatedBy: actor.id },
      });
      if (result.count === 0) throw new NotFoundException("Active app grant not found");
      await tx.auditLogEntry.create({
        data: {
          tenantId, tenantName: consumer.tenant.name, actor: actor.id, actorName: actor.displayName,
          action: "app_consumer.revoke", resourceType: "OAuthApplication",
          resourceId: applicationId, result: "Success", correlationId: randomUUID(),
          changes: { membershipId, applicationId, enabled: false },
        },
      });
      return { applicationId, enabled: false };
    });
  }

  /**
   * Native RP login is an infrastructure client, not an app grant. Preserve
   * normal first-time RP login, but never mint an RP token for an App Consumer
   * (including a suspended consumer whose old session could still exist).
   * Identity is resolved solely from the verified signed ZITADEL subject.
   * A DB outage must reject token issuance; callers must not bypass errors.
   */
  async mayIssueNativeRpToken(issuer: string, externalSubject: string): Promise<boolean> {
    if (!issuer.startsWith("https://") || !/^\d{1,64}$/.test(externalSubject)) return false;
    const consumer = await this.prisma.tenantAppConsumer.findFirst({
      where: {
        membership: {
          user: {
            identities: {
              some: {
                issuer, externalSubject, providerType: "zitadel", identityProviderId: null,
              },
            },
          },
        },
      },
      select: { membershipId: true },
    });
    return consumer === null;
  }

  /**
   * Issuer-global pre-token Actions V2 also runs for pre-existing OAuth and
   * dynamically registered MCP clients not managed by RP. Do not change their
   * ZITADEL authorization model: non-App-Consumers remain eligible for those
   * upstream-managed clients. App Consumers never get that legacy path.
   *
   * Registered tenant OAuthApplication clients always use their exact tenant
   * grants, so this path cannot bypass App Consumer client entitlements.
   */
  async mayIssueLegacyClientToken(
    issuer: string,
    externalSubject: string,
    clientId: string,
  ): Promise<boolean> {
    if (!clientId || !issuer.startsWith("https://") ||
        !/^\d{1,64}$/.test(externalSubject)) return false;
    const managed = await this.prisma.oAuthApplication.findUnique({
      where: { clientId },
      select: { id: true, tenantId: true },
    });
    // Platform applications have tenantId=null and are authorized by
    // ZITADEL upstream for ordinary identities. Only tenant-managed apps
    // require exact RP tenant/project/entitlement checks.
    if (managed?.tenantId) {
      return this.mayIssueClientToken(issuer, externalSubject, clientId);
    }
    // Never bypass the App Consumer boundary for platform/legacy clients.
    return this.mayIssueNativeRpToken(issuer, externalSubject);
  }

  /**
   * Only call with issuer, subject and client ID obtained from an authenticated
   * ZITADEL Actions V2 webhook. Unknown identities, projects, apps or grants
   * deny by default. This service does not itself expose a public webhook.
   */
  async mayIssueClientToken(
    issuer: string,
    externalSubject: string,
    clientId: string,
  ): Promise<boolean> {
    if (!issuer.startsWith("https://") || !externalSubject || !clientId) return false;
    const application = await this.prisma.oAuthApplication.findUnique({
      where: { clientId },
      select: {
        id: true, tenantId: true, zitadelProjectId: true,
        tenant: { select: { status: true, tenantOidcProvider: {
          select: { issuer: true, zitadelProjectId: true, enabled: true, status: true },
        } } },
      },
    });
    const tenantId = application?.tenantId;
    const provider = application?.tenant?.tenantOidcProvider;
    if (!tenantId || !application.zitadelProjectId || !provider?.enabled ||
        provider.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, "") ||
        provider.zitadelProjectId !== application.zitadelProjectId ||
        application.tenant?.status !== "Active") return false;

    const identity = await this.prisma.userIdentity.findUnique({
      where: { issuer_externalSubject: { issuer, externalSubject } },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!identity || identity.user.status !== UserStatus.Active ||
        identity.providerType !== "zitadel" || identity.identityProviderId !== null) return false;

    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: identity.userId, tenantId } },
      include: {
        roles: true,
        groupMemberships: { include: { group: { include: { roles: true } } } },
        appConsumer: {
          include: { grants: { where: { enabled: true },
            select: { oauthApplicationId: true } } },
        },
      },
    });
    if (!membership || membership.status !== MembershipStatus.Active) return false;

    // Existing role-bearing RP members historically used project-scoped
    // ZITADEL roles for these OAuth applications. Preserve that behavior
    // during the issuer-global cutover. The App Consumer category below
    // remains per-client and has no fallback.
    if (!membership.appConsumer) {
      return membership.roles.length > 0 ||
        membership.groupMemberships.some((row) => row.group.roles.length > 0);
    }
    // A consumer with any RP role (direct/inherited) is an invalid state:
    // do not let a malformed consumer also inherit portal permissions.
    if (membership.roles.length || membership.groupMemberships.some((g) => g.group.roles.length)) return false;
    return membership.appConsumer.grants.some((g) => g.oauthApplicationId === application.id);
  }

  private async requireActiveConsumer(tenantId: string, membershipId: string) {
    const consumer = await this.prisma.tenantAppConsumer.findFirst({
      where: { membershipId, tenantId },
      include: { tenant: { select: { name: true } },
        membership: { include: {
        user: { select: { status: true } },
        roles: true,
        groupMemberships: { include: { group: { include: { roles: true } } } },
      } } },
    });
    if (!consumer) throw new NotFoundException("App Consumer not found in tenant");
    if (consumer.membership.status !== MembershipStatus.Active ||
        consumer.membership.user.status !== UserStatus.Active) {
      throw new ForbiddenException("Active App Consumer required");
    }
    if (consumer.membership.roles.length ||
        consumer.membership.groupMemberships.some((g) => g.group.roles.length)) {
      throw new ConflictException("App Consumer must not possess ResourcePortal roles");
    }
    return consumer;
  }
}
