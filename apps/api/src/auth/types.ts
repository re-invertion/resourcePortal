import { UserStatus } from "@prisma/client";

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
};

export type TenantContext = {
  tenantId: string;
  membershipId: string;
  permissions: string[];
};
