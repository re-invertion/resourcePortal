import { containsIpv4, parseIpv4Cidr } from "./network-addressing";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const maxProofAgeMs = 30_000;
const clockSkewMs = 5_000;
const minRemainingLeaseMs = 30_000;

export type RemoteLanLeaseTarget = {
  attachmentId: string;
  tenantId: string;
  singleAppId: string;
  gateId: string;
  macAddress: string;
  lanCidr: string;
  transportRevision: number;
  status: "Provisioning";
};
type ProofIdentity = {
  attachmentId: string;
  tenantId: string;
  singleAppId: string;
  gateId: string;
  transportRevision: number;
  observedAtMs: number;
};
type DhcpObservation = {
  macAddress: string;
  assignedIp: string;
  prefixLength: number;
  dhcpServer: string;
  leaseExpiresAtMs: number;
};
export type AppDhcpProof = ProofIdentity & DhcpObservation & {
  appInterfaceUp: boolean;
  peerReachable: boolean;
};
export type GateDhcpProof = ProofIdentity & DhcpObservation & {
  gateBridgeUp: boolean;
  wireguardHandshakeAtMs: number;
};

export type ValidatedRemoteLanLease = {
  assignedIp: string;
  macAddress: string;
  dhcpServer: string;
  leaseExpiresAt: Date;
};

/**
 * Validate two independently authenticated dataplane observations before
 * promoting a pending attachment to Active.
 *
 * IMPORTANT: This function does not authenticate either source. Callers MUST
 * authenticate the app-side node agent and the enrolled RP Gate separately,
 * bind them to the expected container/task and Gate, and ensure observations
 * originate from their respective network namespaces. Untrusted API clients
 * must never be allowed to submit these proofs directly.
 */
export function validateRemoteLanLeaseProof(
  target: RemoteLanLeaseTarget,
  app: AppDhcpProof,
  gate: GateDhcpProof,
  nowMs: number,
): ValidatedRemoteLanLease {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid current time");
  if (target.status !== "Provisioning" ||
      ![target.attachmentId, target.tenantId, target.singleAppId, target.gateId].every(id => uuid.test(id)) ||
      !Number.isSafeInteger(target.transportRevision) || target.transportRevision < 1)
    throw new Error("Attachment is not eligible for activation");
  const expectedMac = target.macAddress.toLowerCase();
  if (!mac.test(expectedMac) || (parseInt(expectedMac.slice(0,2),16) & 3) !== 2)
    throw new Error("Invalid attachment MAC");

  for (const [source, proof] of [["app", app], ["gate", gate]] as const) {
    if (proof.attachmentId !== target.attachmentId ||
        proof.tenantId !== target.tenantId ||
        proof.singleAppId !== target.singleAppId ||
        proof.gateId !== target.gateId ||
        proof.transportRevision !== target.transportRevision)
      throw new Error(source + " proof is not bound to the current attachment revision");
    if (!Number.isSafeInteger(proof.observedAtMs) ||
        proof.observedAtMs > nowMs + clockSkewMs ||
        proof.observedAtMs < nowMs - maxProofAgeMs)
      throw new Error(source + " proof is stale or from the future");
    if (proof.macAddress.toLowerCase() !== expectedMac)
      throw new Error(source + " DHCP MAC does not match the attachment");
    if (!Number.isSafeInteger(proof.leaseExpiresAtMs) ||
        proof.leaseExpiresAtMs < nowMs + minRemainingLeaseMs ||
        proof.leaseExpiresAtMs > nowMs + 90 * 24 * 60 * 60 * 1000)
      throw new Error(source + " DHCP lease is expired or implausible");
  }
  if (!app.appInterfaceUp || !app.peerReachable || !gate.gateBridgeUp ||
      !Number.isSafeInteger(gate.wireguardHandshakeAtMs) ||
      gate.wireguardHandshakeAtMs < nowMs - maxProofAgeMs ||
      gate.wireguardHandshakeAtMs > nowMs + clockSkewMs)
    throw new Error("Application, Gate bridge or encrypted transport is not ready");
  if (Math.abs(app.observedAtMs - gate.observedAtMs) > maxProofAgeMs)
    throw new Error("DHCP observations are not contemporaneous");
  if (app.assignedIp !== gate.assignedIp ||
      app.prefixLength !== gate.prefixLength ||
      app.dhcpServer !== gate.dhcpServer ||
      Math.abs(app.leaseExpiresAtMs - gate.leaseExpiresAtMs) > clockSkewMs)
    throw new Error("DHCP ACK and application lease do not agree");
  const lan = parseIpv4Cidr(target.lanCidr);
  const leased = parseIpv4Cidr(app.assignedIp + "/" + app.prefixLength);
  const server = parseIpv4Cidr(app.dhcpServer + "/32");
  const host = parseIpv4Cidr(app.assignedIp + "/32");
  if (!lan || !leased || !server || !host ||
      leased.normalized !== lan.normalized ||
      !containsIpv4(lan, app.assignedIp) ||
      host.network === lan.network || host.network === lan.broadcast)
    throw new Error("DHCP address is not a usable host on the approved LAN");
  return {
    assignedIp: app.assignedIp,
    macAddress: expectedMac,
    dhcpServer: app.dhcpServer,
    leaseExpiresAt: new Date(app.leaseExpiresAtMs),
  };
}
