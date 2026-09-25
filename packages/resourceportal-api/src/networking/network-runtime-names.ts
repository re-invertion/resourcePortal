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
