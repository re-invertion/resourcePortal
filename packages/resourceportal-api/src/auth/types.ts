import { UserStatus } from "@prisma/client";

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
};

export type AuthenticatedServiceIdentity = {
  id: string;
  tenantId: string;
  name: string;
  status: "Active" | "Suspended";
  zitadelUserId: string;
  clientId: string;
};

export type TenantContext = {
  tenantId: string;
  membershipId?: string;
  serviceIdentityId?: string;
  permissions: string[];
};
