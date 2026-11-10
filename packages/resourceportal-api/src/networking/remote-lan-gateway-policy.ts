import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { REMOTE_LAN_PROOF_MAX_AGE_MS } from "./remote-lan-proof-age";
import type { GateRuntimeConfig, GateRuntimeLanAttachment } from "./gate-runtime.types";

/** Local-only authenticated Docker exec channel; never a public or tenant API. */
export const GATE_POLICY_PATH = "/run/rp-gate-lease-policy.json";
export type GateLeaseGrant = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  networkId: string;
  macAddress: string;
  configurationRevision: number;
  status: string;
  verifiedAddress: string | null;
  leaseExpiresAt: string | null;
  lastVerifiedAt: string | null;
  /** Offline authorization expires independently of the DHCP address. */
  authorizationExpiresAt?: string | null;
};
export type GateLeaseSnapshot = {
  gateId: string;
  issuedAt: string;
  grants: GateLeaseGrant[];
};

/** Reject mismatched identities and old/replayed snapshots before any write. */
export function validateGateLeaseSnapshot(
  snapshot: GateLeaseSnapshot, base: GateRuntimeConfig, now = Date.now(),
): boolean {
  if (!snapshot || snapshot.gateId !== base.gateId || !Array.isArray(snapshot.grants) ||
      snapshot.grants.length !== base.remoteLanAttachments.length) return false;
  const issued = Date.parse(snapshot.issuedAt);
  // An already running v4 Gateway may retain its *identical*, verified
  // policy snapshot until the original authorization expires. v3 keeps the
  // existing 45s bound. This must not authorize new attachments or revisions.
  const v4 = base.remoteLanAttachments.length > 0 &&
    base.remoteLanAttachments.every(a => a.authorizationRequired === true);
  const maxAge = v4 ? 600_000 : REMOTE_LAN_PROOF_MAX_AGE_MS;
  if (!Number.isFinite(issued) || issued > now + 5_000 ||
      now - issued > maxAge) return false;
  const expected = new Map(base.remoteLanAttachments.map(a => [a.attachmentId, a]));
  const seen = new Set<string>();
  for (const grant of snapshot.grants) {
    const item = expected.get(grant.attachmentId);
    if (!item || seen.has(grant.attachmentId) ||
        item.tenantId !== grant.tenantId || item.gateId !== grant.gateId ||
        item.networkId !== grant.networkId ||
        item.macAddress.toLowerCase() !== grant.macAddress.toLowerCase() ||
        !Number.isSafeInteger(item.configurationRevision) ||
        item.configurationRevision !== grant.configurationRevision ||
        !["Provisioning", "Active"].includes(grant.status)) return false;
    if (v4 && grant.status === "Active") {
      const end = grant.authorizationExpiresAt ?
        Date.parse(grant.authorizationExpiresAt) : NaN;
      // An old signed-at-ingress snapshot may be replayed, but it can never
      // extend the originally approved authorization or manufacture a lease.
      if (!Number.isFinite(end) || end > issued + maxAge ||
          end <= issued) return false;
    }
    seen.add(grant.attachmentId);
  }
  return true;
}

/** Dynamic evidence is strictly bounded by both authenticated proof age and
 * DHCP lease expiration. Missing/invalid data cannot manufacture an L2 grant.
 */
export function applyGateLeaseSnapshot(
  base: GateRuntimeConfig, snapshot: GateLeaseSnapshot | null, now = Date.now(),
): GateRuntimeConfig {
  if (!snapshot || !validateGateLeaseSnapshot(snapshot, base, now)) return base;
  const byId = new Map(snapshot.grants.map(a => [a.attachmentId, a]));
  return {
    ...base,
    remoteLanAttachments: base.remoteLanAttachments.map((item): GateRuntimeLanAttachment => {
      const grant = byId.get(item.attachmentId)!;
      if (grant.status !== "Active") {
        // Provisioning static IPv4 needs short-lived ARP/IPv4 bootstrap.
        // Never allow its source beyond one fresh authenticated snapshot.
        if (grant.status === "Provisioning" && item.status === "Provisioning" &&
            item.addressMode === "Static" && item.authorizationRequired) {
          const until = Date.parse(snapshot.issuedAt) + REMOTE_LAN_PROOF_MAX_AGE_MS;
          return until > now + 1_000 ?
            {...item, authorizationExpiresAt:new Date(until).toISOString()} : item;
        }
        return item;
      }
      if (item.addressMode === "Static") {
        if (!item.authorizationRequired) return item;
        const until = grant.authorizationExpiresAt ?
          Date.parse(grant.authorizationExpiresAt) : NaN;
        // A static address is configured in the signed policy, but its
        // actual forwarding must still be clipped by the offline TTL.
        if (!Number.isFinite(until) || until <= now + 1_000 ||
            until > now + 600_000) return {
              ...item, status: "Provisioning", authorizationExpiresAt: null,
            };
        return { ...item, status:"Active", authorizationExpiresAt:
          new Date(until).toISOString() };
      }
      if (item.addressMode !== "DHCP") return item;
      const verifiedAt = grant.lastVerifiedAt ? Date.parse(grant.lastVerifiedAt) : NaN;
      const dhcpExpiry = grant.leaseExpiresAt ? Date.parse(grant.leaseExpiresAt) : NaN;
      const authExpiry = grant.authorizationExpiresAt ?
        Date.parse(grant.authorizationExpiresAt) : NaN;
      // New v4 proof can continue only inside an already issued bounded
      // authorization window. Legacy v3 is still limited to fresh 45s proof.
      const maxExpiry = Number.isFinite(authExpiry) && authExpiry <= now + 600_000
        ? authExpiry : verifiedAt + REMOTE_LAN_PROOF_MAX_AGE_MS;
      if (!Number.isFinite(verifiedAt) || verifiedAt > now + 5_000 ||
          !Number.isFinite(maxExpiry) || !Number.isFinite(dhcpExpiry))
        return item;
      const expiry = Math.min(maxExpiry, dhcpExpiry);
      if (expiry <= now + 1_000) return item;
      return { ...item, status: "Active", verifiedAddress: grant.verifiedAddress,
        leaseExpiresAt: new Date(expiry).toISOString() };
    }),
  };
}

export function readGateLeaseSnapshot(): GateLeaseSnapshot | null {
  try {
    const file = readFileSync(GATE_POLICY_PATH, "utf8");
    if (file.length > 200_000) return null;
    return JSON.parse(file) as GateLeaseSnapshot;
  } catch { return null; }
}

/** Atomic replacement; older snapshot cannot overwrite a newer proof. */
export function writeGateLeaseSnapshot(
  snapshot: GateLeaseSnapshot, base: GateRuntimeConfig, now = Date.now(),
): void {
  if (!validateGateLeaseSnapshot(snapshot, base, now))
    throw new Error("Invalid or stale Gateway lease policy");
  const current = readGateLeaseSnapshot();
  if (current && validateGateLeaseSnapshot(current, base, now) &&
      Date.parse(current.issuedAt) > Date.parse(snapshot.issuedAt))
    throw new Error("Out-of-order Gateway lease policy");
  const tmp = GATE_POLICY_PATH + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tmp, GATE_POLICY_PATH);
}
