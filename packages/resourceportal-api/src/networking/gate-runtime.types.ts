export type GateRuntimeLanAttachment = {
  attachmentId: string;
  tenantId: string;
  singleAppId: string;
  gateId: string;
  networkId: string;
  overlayCidr: string;
  serviceName: string;
  macAddress: string;
};
/**
 * Authenticated encrypted L2 underlay and app-scoped bridge grants only.
 * Site-level routed access is deliberately not representable here.
 */
export type GateRuntimeConfig = {
  gateId: string;
  listenPort: number;
  serverTunnelAddress: string;
  clientTunnelAddress: string;
  peerPublicKey: string;
  rpOverlayCidrs: string[];
  privateKeyPath: string;
  remoteLanAttachments: GateRuntimeLanAttachment[];
};
