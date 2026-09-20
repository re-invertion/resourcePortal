export const RESOURCEPORTAL_NODE_LABELS = {
  controlPlane: "rp.node.control-plane",
  storage: "rp.node.storage",
  ingress: "rp.node.ingress",
  tenantWorkloads: "rp.node.tenant-workloads",
} as const;

export const LEGACY_STORAGE_NODE_LABELS = {
  authoritative: "resourceportal.storage.authoritative",
  volumes: "resourceportal.storage.volumes",
  secrets: "resourceportal.storage.secrets",
  platform: "resourceportal.storage.platform",
} as const;

export function nodeLabelConstraint(label: string) {
  return `node.labels.${label} == true`;
}

export function dockerNodeLabelConstraint(label: string) {
  return `node.labels.${label}==true`;
}
