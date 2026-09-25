export type GateRuntimeMapping = {
  stableAddress: string;
  overlayCidr: string;
  attachmentAlias: string;
};

export type GateRuntimeConfig = {
  gateId: string;
  listenPort: number;
  serverTunnelAddress: string;
  clientTunnelAddress: string;
  peerPublicKey: string;
  peerLanCidrs: string[];
  privateKeyPath: string;
  mappings: GateRuntimeMapping[];
};
