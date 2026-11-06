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
  if (!Number.isFinite(issued) || issued > now + 5_000 ||
      now - issued > REMOTE_LAN_PROOF_MAX_AGE_MS) return false;
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
      if (item.addressMode !== "DHCP" || grant.status !== "Active") return item;
      const verifiedAt = grant.lastVerifiedAt ? Date.parse(grant.lastVerifiedAt) : NaN;
      const lease = grant.leaseExpiresAt ? Date.parse(grant.leaseExpiresAt) : NaN;
      if (!Number.isFinite(verifiedAt) || verifiedAt > now + 5_000 ||
          now - verifiedAt >= REMOTE_LAN_PROOF_MAX_AGE_MS ||
          !Number.isFinite(lease)) return item;
      const expiry = Math.min(verifiedAt + REMOTE_LAN_PROOF_MAX_AGE_MS, lease);
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
