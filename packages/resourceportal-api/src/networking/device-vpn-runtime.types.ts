export type DeviceVpnRuntimePeer = {
  deviceId: string;
  publicKey: string;
  assignedAddress: string;
  networkIds: string[];
};

export type DeviceVpnRuntimeMapping = {
  networkId: string;
  stableAddress: string;
  overlayCidr: string;
  attachmentAlias: string;
};

export type DeviceVpnRuntimeConfig = {
  gatewayId: string;
  listenPort: number;
  serverTunnelAddress: string;
  privateKeyPath: string;
  runtimeTokenPath: string;
  heartbeatUrl: string;
  peers: DeviceVpnRuntimePeer[];
  mappings: DeviceVpnRuntimeMapping[];
};
