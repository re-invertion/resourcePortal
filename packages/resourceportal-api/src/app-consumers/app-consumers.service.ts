import {
  ForbiddenException, Injectable, NotFoundException,
} from "@nestjs/common";
import { MembershipStatus, Prisma, UserStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";

/** The same User/TenantMembership owns RP RBAC and application-specific SSO. */
export type NativeClientKey = "web" | "cli";
const SSO_ROLE = "sso-login";
const NATIVE_KEYS: NativeClientKey[] = ["web", "cli"];

@Injectable()
export class AppConsumersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    const memberships = await this.prisma.tenantMembership.findMany({
      where: { tenantId },
      include: {
        user: { select: { id: true, email: true, displayName: true, status: true } },
        appGrants: { include: {
          application: { select: { id: true, name: true } },
        } },
        nativeAppGrants: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((membership) => ({
      membershipId: membership.id,
      status: membership.status,
      user: membership.user,
      createdAt: membership.createdAt,
      grants: membership.appGrants.map((grant) => ({
        applicationId: grant.oauthApplicationId,
        applicationName: grant.application.name,
        enabled: grant.enabled,
        updatedAt: grant.updatedAt,
      })),
      nativeGrants: membership.nativeAppGrants.map((grant) => ({
        clientKey: grant.clientKey,
        enabled: grant.enabled,
        updatedAt: grant.updatedAt,
      })),
    }));
  }

  async grant(tenantId: string, membershipId: string, applicationId: string, actor: AuthenticatedUser) {
    return this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, tenantId, membershipId, actor);
      const application = await tx.oAuthApplication.findFirst({
        where: { id: applicationId, tenantId }, select: { id: true, name: true },
      });
      if (!application) throw new NotFoundException("OAuthApplication not found in tenant");
      const record = await tx.tenantAppClientGrant.upsert({
        where: { membershipId_oauthApplicationId: { membershipId, oauthApplicationId: applicationId } },
        create: { membershipId, tenantId, oauthApplicationId: applicationId,
          createdBy: actor.id, updatedBy: actor.id, enabled: true },
        update: { enabled: true, updatedBy: actor.id },
      });
      await this.audit(tx, tenantId, member.tenant.name, actor, "membership.app_grant.grant",
        applicationId, application.name, { membershipId, applicationId, enabled: true });
      return { id: record.id, applicationId, enabled: record.enabled };
    });
  }

  async revoke(tenantId: string, membershipId: string, applicationId: string, actor: AuthenticatedUser) {
    return this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, tenantId, membershipId, actor);
      const result = await tx.tenantAppClientGrant.updateMany({
        where: { membershipId, tenantId, oauthApplicationId: applicationId, enabled: true },
        data: { enabled: false, updatedBy: actor.id },
      });
      if (!result.count) throw new NotFoundException("Active app grant not found");
      await this.audit(tx, tenantId, member.tenant.name, actor, "membership.app_grant.revoke",
        applicationId, undefined, { membershipId, applicationId, enabled: false });
      return { applicationId, enabled: false };
    });
  }

  async grantNative(tenantId: string, membershipId: string, clientKey: NativeClientKey, actor: AuthenticatedUser) {
    this.assertNativeKey(clientKey);
    return this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, tenantId, membershipId, actor);
      const record = await tx.tenantNativeAppGrant.upsert({
        where: { membershipId_clientKey: { membershipId, clientKey } },
        create: { membershipId, tenantId, clientKey, createdBy: actor.id, updatedBy: actor.id },
        update: { enabled: true, updatedBy: actor.id },
      });
      await this.audit(tx, tenantId, member.tenant.name, actor, "membership.native_grant.grant",
        membershipId, undefined, { membershipId, clientKey, enabled: true });
      return { clientKey, enabled: record.enabled };
    });
  }

  async revokeNative(tenantId: string, membershipId: string, clientKey: NativeClientKey, actor: AuthenticatedUser) {
    this.assertNativeKey(clientKey);
    return this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, tenantId, membershipId, actor);
      const result = await tx.tenantNativeAppGrant.updateMany({
        where: { membershipId, tenantId, clientKey, enabled: true },
        data: { enabled: false, updatedBy: actor.id },
      });
      if (!result.count) throw new NotFoundException("Active native app grant not found");
      await this.audit(tx, tenantId, member.tenant.name, actor, "membership.native_grant.revoke",
        membershipId, undefined, { membershipId, clientKey, enabled: false });
      return { clientKey, enabled: false };
    });
  }

  /** A signed ZITADEL user subject and exactly one physical RP client. */
  async mayIssueNativeRpToken(issuer: string, externalSubject: string, clientKey: NativeClientKey): Promise<boolean> {
    if (!issuer.startsWith("https://") || !/^\d{1,64}$/.test(externalSubject) ||
        !NATIVE_KEYS.includes(clientKey)) return false;
    const identity = await this.verifiedIdentity(issuer, externalSubject);
    if (!identity) return false;
    return Boolean(await this.prisma.tenantMembership.findFirst({
      where: {
        userId: identity.userId, status: MembershipStatus.Active,
        tenant: { status: "Active" },
        nativeAppGrants: { some: { clientKey, enabled: true } },
        OR: [
          { roles: { some: { roleId: SSO_ROLE } } },
          { groupMemberships: { some: { group: { roles: { some: { roleId: SSO_ROLE } } } } } },
        ],
      },
      select: { id: true },
    }));
  }

  /**
   * Only registered tenant OAuth applications are covered by this entitlement.
   * An unknown client, platform OAuth app or MCP DCR is not a fallback from the
   * issuer-global pre-token hook; onboard it via a separately certified policy.
   */
  async mayIssueLegacyClientToken(issuer: string, externalSubject: string, clientId: string): Promise<boolean> {
    if (!issuer.startsWith("https://") || !clientId || !/^\d{1,64}$/.test(externalSubject)) return false;
    const application = await this.prisma.oAuthApplication.findUnique({
      where: { clientId }, select: { tenantId: true },
    });
    return application?.tenantId
      ? this.mayIssueClientToken(issuer, externalSubject, clientId)
      : false;
  }

  async mayIssueClientToken(issuer: string, externalSubject: string, clientId: string): Promise<boolean> {
    if (!issuer.startsWith("https://") || !/^\d{1,64}$/.test(externalSubject) || !clientId) return false;
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
    if (!tenantId || !application?.zitadelProjectId || !provider?.enabled ||
        provider.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, "") ||
        provider.zitadelProjectId !== application.zitadelProjectId ||
        application.tenant?.status !== "Active") return false;

    const identity = await this.verifiedIdentity(issuer, externalSubject);
    if (!identity) return false;
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: identity.userId, tenantId } },
      include: {
        roles: { select: { roleId: true } },
        groupMemberships: { include: { group: {
          include: { roles: { select: { roleId: true } } },
        } } },
        appGrants: { where: { oauthApplicationId: application.id, enabled: true },
          select: { id: true } },
      },
    });
    if (!membership || membership.status !== MembershipStatus.Active) return false;
    const sso = membership.roles.some((row) => row.roleId === SSO_ROLE) ||
      membership.groupMemberships.some((row) =>
        row.group.roles.some((role) => role.roleId === SSO_ROLE));
    return sso && membership.appGrants.length > 0;
  }

  /**
   * MCP DCR token entitlement is independent of RP Web/CLI and tenant app
   * grants. The DCR client itself is verified separately against ZITADEL's
   * DCR project. At token/refresh time require a currently enabled MCP tenant,
   * active membership, explicit MCP access and the SSO login capability.
   *
   * A DCR token can carry the RP project audience; it is not a tenant grant.
   * TenantMcpAccessGuard rechecks the exact requested tenant on every call.
   */
  async mayIssueMcpDcrToken(issuer: string, externalSubject: string): Promise<boolean> {
    if (!issuer.startsWith("https://") || !/^\d{1,64}$/.test(externalSubject)) return false;
    const identity = await this.verifiedIdentity(issuer, externalSubject);
    if (!identity) return false;
    const memberships = await this.prisma.tenantMembership.findMany({
      where: {
        userId: identity.userId,
        status: MembershipStatus.Active,
        tenant: { status: "Active" },
        OR: [
          { roles: { some: { roleId: SSO_ROLE } } },
          { groupMemberships: { some: { group: { roles: { some: { roleId: SSO_ROLE } } } } } },
        ],
      },
      select: {
        id: true,
        tenant: {
          select: {
            mcpSettings: {
              select: {
                enabled: true,
                accessMode: true,
                allowedMembers: { select: { membershipId: true } },
              },
            },
          },
        },
      },
    });
    return memberships.some(({ id, tenant }) => {
      const settings = tenant.mcpSettings;
      return settings?.enabled === true &&
        (settings.accessMode === "AllMembers" ||
          (settings.accessMode === "SelectedMembers" &&
            settings.allowedMembers.some((row) => row.membershipId === id)));
    });
  }

  private async verifiedIdentity(issuer: string, externalSubject: string) {
    const identity = await this.prisma.userIdentity.findUnique({
      where: { issuer_externalSubject: { issuer, externalSubject } },
      include: { user: { select: { status: true } } },
    });
    return identity && identity.user.status === UserStatus.Active &&
      identity.providerType === "zitadel" && identity.identityProviderId === null ? identity : null;
  }

  private assertNativeKey(value: string): asserts value is NativeClientKey {
    if (!NATIVE_KEYS.includes(value as NativeClientKey)) throw new ForbiddenException("Unknown native client");
  }

  /** Tenant lock serializes membership deletion, role changes and grants. */
  private async lockedMember(
    tx: Prisma.TransactionClient, tenantId: string, membershipId: string, actor: AuthenticatedUser,
  ) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`);
    const member = await tx.tenantMembership.findFirst({
      where: { id: membershipId, tenantId },
      include: { tenant: { select: { name: true, status: true } }, user: { select: { status: true } } },
    });
    if (!member) throw new NotFoundException("Tenant membership not found");
    if (actor.id === member.userId) throw new ForbiddenException("Self-granting application access is forbidden");
    if (member.status !== MembershipStatus.Active || member.user.status !== UserStatus.Active ||
        member.tenant.status !== "Active") throw new ForbiddenException("Active tenant membership is required");
    return member;
  }

  private async audit(
    tx: Prisma.TransactionClient, tenantId: string, tenantName: string, actor: AuthenticatedUser,
    action: string, resourceId: string, resourceName: string | undefined, changes: Record<string, unknown>,
  ) {
    await tx.auditLogEntry.create({ data: {
      tenantId, tenantName, actor: actor.id, actorName: actor.displayName,
      action, resourceType: "TenantApplicationGrant", resourceId, resourceName,
      result: "Success", correlationId: randomUUID(), changes: changes as Prisma.InputJsonValue,
    } });
  }
}
