import { describe, expect, it } from "vitest";
import {
  renderRuntimeVolumeMount,
  storagePlacementConstraints,
} from "./stack-storage";

describe("Stage 14 stack storage rendering", () => {
  it("renders a canonical bind source for an attached Volume", () => {
    expect(renderRuntimeVolumeMount({
      runtimeRoot: "/mnt/resourceportal/volumes",
      tenantId: "tenant-a",
      volumeId: "volume-a",
      mountPath: "/data",
      mode: "ReadWrite",
    })).toBe("/mnt/resourceportal/volumes/tenant-a/volume-a:/data:rw");
  });

  it("renders read-only mounts", () => {
    expect(renderRuntimeVolumeMount({
      runtimeRoot: "/mnt/resourceportal/volumes",
      tenantId: "tenant-a",
      volumeId: "volume-a",
      mountPath: "/data",
      mode: "ReadOnly",
    })).toBe("/mnt/resourceportal/volumes/tenant-a/volume-a:/data:ro");
  });

  it("requires tenant workload capability for every tenant service", () => {
    expect(storagePlacementConstraints(false)).toEqual([
      "node.labels.rp.node.tenant-workloads == true",
    ]);
  });

  it("adds storage readiness only when a service uses a Volume", () => {
    expect(storagePlacementConstraints(true)).toEqual([
      "node.labels.rp.node.tenant-workloads == true",
      "node.labels.rp.node.storage == true",
      "node.labels.resourceportal.storage.volumes == true",
    ]);
  });
});
