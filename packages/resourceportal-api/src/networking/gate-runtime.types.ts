export type GateRuntimeMapping = {
  stableAddress: string;
  overlayCidr: string;
  attachmentAlias: string;
  serviceName?: string;
};

export type GateRuntimeApplicationLanRule = {
  attachmentAlias: string;
  destinationCidr: string;
  protocol: "tcp" | "udp";
  port: number;
};
export type GateRuntimeDiscoveryRule = {
  attachmentAlias: string;
  protocol: "mdns" | "ssdp";
};

export type GateRuntimeConfig = {
  gateId: string;
  listenPort: number;
  serverTunnelAddress: string;
  clientTunnelAddress: string;
  peerPublicKey: string;
  peerLanCidrs: string[];
  allowLanToRp?: boolean;
  allowRpToLan?: boolean;
  rpOverlayCidrs?: string[];
  applicationAccessMode?: "Legacy" | "PerApplication";
  applicationLanRules?: GateRuntimeApplicationLanRule[];
  discoveryRules?: GateRuntimeDiscoveryRule[];
  privateKeyPath: string;
  mappings: GateRuntimeMapping[];
};
