import { volumeRuntimePath } from "../storage-backends/storage-paths";

export function renderRuntimeVolumeMount(input: {
  runtimeRoot: string;
  tenantId: string;
  volumeId: string;
  mountPath: string;
  mode: "ReadOnly" | "ReadWrite";
}): string {
  const source = volumeRuntimePath(input.runtimeRoot, input.tenantId, input.volumeId);
  return `${source}:${input.mountPath}:${input.mode === "ReadOnly" ? "ro" : "rw"}`;
}

export function storagePlacementConstraints(hasVolumes: boolean): string[] {
  return hasVolumes
    ? ["node.labels.resourceportal.storage.volumes == true"]
    : [];
}
