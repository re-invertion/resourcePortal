import { Role, TenantMembership, User } from "@prisma/client";

type MembershipWithRelations = TenantMembership & {
  user: Pick<User, "id" | "email" | "displayName" | "status">;
  roles: Array<{ role: Role }>;
};

export function mapMembership(membership: MembershipWithRelations) {
  return {
    id: membership.id,
    tenantId: membership.tenantId,
    userId: membership.userId,
    status: membership.status,
    user: membership.user,
    roles: membership.roles.map(({ role }) => ({
      id: role.id,
      name: role.name,
      permissions: role.permissions,
    })),
    createdBy: membership.createdBy,
    createdAt: membership.createdAt,
  };
}
