export function networkComposeAlias(networkId: string) {
  return `rpnet_${networkId.replaceAll("-", "_")}`;
}

export function networkAttachmentAlias(attachmentId: string) {
  return `rp-att-${attachmentId}`;
}

export function gateStackName(gateId: string) {
  return `rp_gate_${gateId.replaceAll("-", "_")}`;
}

export function gatePrivateSecretName(gateId: string, keyVersion = 1) {
  return `rp-gate-${gateId}-private-key-v${keyVersion}`;
}

export function deviceVpnStackName() {
  return "rp_device_vpn";
}

export function deviceVpnPrivateSecretName(keyVersion = 1) {
  return `rp-device-vpn-private-key-v${keyVersion}`;
}

export function deviceVpnRuntimeTokenSecretName(keyVersion = 1) {
  return `rp-device-vpn-runtime-token-v${keyVersion}`;
}
