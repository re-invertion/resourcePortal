import {
  BillingAccount,
  BillingTransaction,
  Quota,
  Role,
  TenantMembership,
  UsageRecord,
  User,
} from "@prisma/client";

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

export function mapBillingAccount(
  billing: BillingAccount & {
    transactions?: BillingTransaction[];
    usageRecords?: UsageRecord[];
  },
) {
  return {
    id: billing.id,
    tenantId: billing.tenantId,
    balance: billing.balance.toString(),
    currency: billing.currency,
    informationThreshold: billing.informationThreshold.toString(),
    transactions: billing.transactions?.map(mapBillingTransaction),
    usageRecords: billing.usageRecords?.map(mapUsageRecord),
  };
}

export function mapBillingTransaction(transaction: BillingTransaction) {
  return {
    id: transaction.id,
    billingAccountId: transaction.billingAccountId,
    type: transaction.type,
    amount: transaction.amount.toString(),
    balanceBefore: transaction.balanceBefore.toString(),
    balanceAfter: transaction.balanceAfter.toString(),
    status: transaction.status,
    reference: transaction.reference,
    createdAt: transaction.createdAt,
  };
}

export function mapUsageRecord(usageRecord: UsageRecord) {
  return {
    id: usageRecord.id,
    billingAccountId: usageRecord.billingAccountId,
    tenantId: usageRecord.tenantId,
    resourceType: usageRecord.resourceType,
    resourceId: usageRecord.resourceId,
    periodStart: usageRecord.periodStart,
    periodEnd: usageRecord.periodEnd,
    usage: usageRecord.usage,
    cost: usageRecord.cost.toString(),
  };
}

export function mapQuota(quota: Quota) {
  return {
    id: quota.id,
    tenantId: quota.tenantId,
    cpu: quota.cpu.toString(),
    memoryBytes: quota.memoryBytes.toString(),
    gpu: quota.gpu,
    storageBytes: quota.storageBytes.toString(),
    maxSingleApps: quota.maxSingleApps,
    maxVolumes: quota.maxVolumes,
    createdBy: quota.createdBy,
    updatedBy: quota.updatedBy,
    createdAt: quota.createdAt,
    updatedAt: quota.updatedAt,
  };
}
