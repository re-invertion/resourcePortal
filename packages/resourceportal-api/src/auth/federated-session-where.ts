import type { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";

/** Only USABLE incoming federated sessions block the cutover. Historical
 * revoked, expired and idle sessions must remain as immutable audit evidence
 * rather than permanently preventing a one-click upgrade.
 */
export function activeFederatedSessionWhere(
  config: ConfigService,
  now = new Date(),
): Prisma.PortalSessionWhereInput {
  const defaultSeconds = 12 * 60 * 60;
  const raw = Number.parseInt(config.get<string>(
    "AUTH_SESSION_IDLE_TIMEOUT_SECONDS", String(defaultSeconds),
  ), 10);
  const idleSeconds = Number.isFinite(raw) && raw > 0 ? raw : defaultSeconds;
  return {
    authenticatedIdpId: { not: null },
    revokedAt: null,
    expiresAt: { gt: now },
    lastSeenAt: { gt: new Date(now.getTime() - idleSeconds * 1000) },
  };
}
