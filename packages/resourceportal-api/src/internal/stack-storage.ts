import { volumeRuntimePath } from "../storage-backends/storage-paths";
import {
  LEGACY_STORAGE_NODE_LABELS,
  nodeLabelConstraint,
  RESOURCEPORTAL_NODE_LABELS,
} from "./node-labels";

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
  return [
    nodeLabelConstraint(RESOURCEPORTAL_NODE_LABELS.tenantWorkloads),
    ...(hasVolumes
      ? [
          nodeLabelConstraint(RESOURCEPORTAL_NODE_LABELS.storage),
          nodeLabelConstraint(LEGACY_STORAGE_NODE_LABELS.volumes),
        ]
      : []),
  ];
}
