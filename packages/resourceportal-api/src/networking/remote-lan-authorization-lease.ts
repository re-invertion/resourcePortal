import { REMOTE_LAN_PROOF_MAX_AGE_MS } from "./remote-lan-proof-age";

/** Candidate upper bound, pending independent security review (#422). */
export const REMOTE_LAN_AUTHORIZATION_TTL_MS = 600_000;

/** Distinct from the customer's DHCP lease. This is an HTTPS + nonce-bound
 * authorization to continue an ALREADY active, unchanged attachment. */
export type RemoteLanAuthorizationGrant = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  singleAppId: string;
  networkId: string;
  macAddress: string;
  configurationRevision: number;
};
export type RemoteLanAuthorizationLease = {
  protocol: 1;
  gateId: string;
  tenantId: string;
  nonce: string;
  issuedAtMs: number;
  ttlSeconds: number;
  grants: RemoteLanAuthorizationGrant[];
  /** One-time authenticated instruction: keep only the exact previous
   * LOCAL deadline, never turn an old grant into a fresh 600s renewal. */
  retainExisting?: true;
};
export type LeaseProof = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  singleAppId: string;
  configurationRevision: number;
  macAddress: string;
  gatewayTunnelOwned: boolean;
  bridgeOwned: boolean;
  macLearnedOnTunnel: boolean;
};
export type LeaseCandidate = RemoteLanAuthorizationGrant & {
  status: string;
  lastVerifiedAt: Date | null;
};
/**
 * A prior successful authenticated Gate/Node activation and this heartbeat's
 * authenticated local L2 observation are both mandatory. New attachments,
 * old agents and changed revisions receive NO offline grant. No DB schema
 * changes and no unilateral clock-based extension on communication failure.
 */
export function issueRemoteLanAuthorizationLease(input: {
  gateId: string;
  tenantId: string;
  agentVersion: string;
  nonce?: string;
  candidates: readonly LeaseCandidate[];
  proofs: readonly LeaseProof[];
  now?: number;
}): RemoteLanAuthorizationLease | null {
  if (input.agentVersion !== "gate-l2-v4" ||
      !/^[0-9a-f]{64}$/.test(input.nonce ?? "")) return null;
  const now = input.now ?? Date.now();
  const proofs = new Map(input.proofs.map(proof => [proof.attachmentId, proof]));
  const grants = input.candidates.filter(row => {
    const proof = proofs.get(row.attachmentId);
    const at = row.lastVerifiedAt?.getTime();
    return row.gateId === input.gateId && row.tenantId === input.tenantId &&
      row.status === "Active" && !!proof &&
      row.singleAppId === proof.singleAppId &&
      row.configurationRevision === proof.configurationRevision &&
      row.tenantId === proof.tenantId && row.gateId === proof.gateId &&
      row.macAddress.toLowerCase() === proof.macAddress.toLowerCase() &&
      proof.gatewayTunnelOwned && proof.bridgeOwned && proof.macLearnedOnTunnel &&
      at !== undefined && Number.isFinite(at) &&
      at <= now + 5_000 && now - at < REMOTE_LAN_PROOF_MAX_AGE_MS;
  }).map(({ attachmentId, tenantId, gateId, singleAppId, networkId,
    macAddress, configurationRevision }) => ({
    attachmentId, tenantId, gateId, singleAppId, networkId,
    macAddress, configurationRevision,
  })).sort((a,b) => a.attachmentId.localeCompare(b.attachmentId));
  return {
    protocol: 1, gateId: input.gateId, tenantId: input.tenantId,
    nonce: input.nonce!, issuedAtMs: now,
    ttlSeconds: REMOTE_LAN_AUTHORIZATION_TTL_MS / 1_000, grants,
  };
}

export type PersistedRemoteLanAuthorization = {
  issuedAtMs: number;
  grants: RemoteLanAuthorizationGrant[];
};

/** During the FIRST recovered heartbeat after an outage, the Gate can have
 * fresh authenticated local L2 proof but stale DB activation timestamp.
 * Do NOT replace the old, exact-scoped server grant with a new deadline.
 * Carry only an unexpired previously approved grant for the exact unchanged
 * full Active topology; bad/missing proofs or any revocation fail closed.
 */
export function retainedRemoteLanAuthorization(input: {
  gate: {
    gateId: string; tenantId: string; agentVersion?: string | null;
    revokedAt?: Date | null; observedL2Diagnostic?: unknown;
  };
  candidates: readonly LeaseCandidate[];
  proofs: readonly LeaseProof[];
  now?: number;
}): PersistedRemoteLanAuthorization | null {
  const now = input.now ?? Date.now();
  const {gate,candidates,proofs} = input;
  if (gate.agentVersion !== "gate-l2-v4" || gate.revokedAt ||
      candidates.length < 1 || candidates.length > 64 ||
      proofs.length !== candidates.length) return null;
  const original = gate.observedL2Diagnostic;
  if (!original || typeof original !== "object" || Array.isArray(original))
    return null;
  const old = (original as Record<string,unknown>).authorizationLease;
  if (!old || typeof old !== "object" || Array.isArray(old)) return null;
  const stamp = old as {issuedAtMs?: unknown; grants?: unknown};
  if (typeof stamp.issuedAtMs !== "number" ||
      !Number.isSafeInteger(stamp.issuedAtMs) || !Array.isArray(stamp.grants) ||
      stamp.grants.length !== candidates.length) return null;
  const byId = new Map(proofs.map(item => [item.attachmentId,item]));
  if (byId.size !== candidates.length ||
      new Set(candidates.map(item=>item.attachmentId)).size !== candidates.length)
    return null;
  const grants: RemoteLanAuthorizationGrant[] = [];
  for(const candidate of candidates) {
    const proof = byId.get(candidate.attachmentId);
    if (candidate.status !== "Active" || !proof ||
        proof.tenantId !== candidate.tenantId ||
        proof.gateId !== candidate.gateId ||
        proof.singleAppId !== candidate.singleAppId ||
        proof.configurationRevision !== candidate.configurationRevision ||
        proof.macAddress.toLowerCase() !== candidate.macAddress.toLowerCase() ||
        !proof.gatewayTunnelOwned || !proof.bridgeOwned ||
        !proof.macLearnedOnTunnel) return null;
    const grant:RemoteLanAuthorizationGrant = {
      attachmentId:candidate.attachmentId,tenantId:candidate.tenantId,
      gateId:candidate.gateId,singleAppId:candidate.singleAppId,
      networkId:candidate.networkId,macAddress:candidate.macAddress,
      configurationRevision:candidate.configurationRevision,
    };
    if (remoteLanAuthorizationExpiry(gate,grant,now) === null) return null;
    grants.push(grant);
  }
  return {issuedAtMs:stamp.issuedAtMs,
    grants:grants.sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId))};
}

/** The worker must never derive a new deadline from updated heartbeat time.
 * Only a successful server-issued grant persisted in the Gate's private DB
 * diagnostic field creates an offline authorization; the exact revision,
 * attachment, network, tenant, MAC and app ID must remain unchanged.
 */
export function remoteLanAuthorizationExpiry(input: {
  gateId: string;
  tenantId: string;
  agentVersion?: string | null;
  revokedAt?: Date | null;
  observedL2Diagnostic?: unknown;
}, attachment: RemoteLanAuthorizationGrant, now = Date.now()): number | null {
  if (input.agentVersion !== "gate-l2-v4" || input.revokedAt ||
      input.gateId !== attachment.gateId || input.tenantId !== attachment.tenantId)
    return null;
  const diag = input.observedL2Diagnostic;
  if (!diag || typeof diag !== "object" || Array.isArray(diag)) return null;
  const auth = (diag as Record<string,unknown>).authorizationLease;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const { issuedAtMs, grants } = auth as { issuedAtMs?: unknown; grants?: unknown };
  if (typeof issuedAtMs !== "number" ||
      !Number.isSafeInteger(issuedAtMs) || issuedAtMs > now + 5_000 ||
      now >= issuedAtMs + REMOTE_LAN_AUTHORIZATION_TTL_MS ||
      !Array.isArray(grants) || grants.length > 64) return null;
  const matches = grants.filter(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const item = candidate as Partial<RemoteLanAuthorizationGrant>;
    return item.attachmentId === attachment.attachmentId &&
      item.tenantId === attachment.tenantId &&
      item.gateId === attachment.gateId &&
      item.singleAppId === attachment.singleAppId &&
      item.networkId === attachment.networkId &&
      item.configurationRevision === attachment.configurationRevision &&
      typeof item.macAddress === "string" &&
      item.macAddress.toLowerCase() === attachment.macAddress.toLowerCase();
  });
  return matches.length === 1 ?
    issuedAtMs + REMOTE_LAN_AUTHORIZATION_TTL_MS : null;
}
