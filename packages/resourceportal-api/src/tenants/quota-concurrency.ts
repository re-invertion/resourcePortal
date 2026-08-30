import { Prisma } from "@prisma/client";

const QUOTA_LOCK_NAMESPACE = "resourceportal:quota";

export async function lockTenantQuota(
  tx: Prisma.TransactionClient,
  tenantId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${QUOTA_LOCK_NAMESPACE}:${tenantId}`}, 0))`,
  );
}
