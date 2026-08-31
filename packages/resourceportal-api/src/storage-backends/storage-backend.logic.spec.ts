import { HealthState } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildNfsDriverOptions,
  cephHealthToState,
  parseCephCapacity,
  resolveCephFsLocalPath,
} from "./storage-backend.logic";

describe("Stage 14 storage backend logic", () => {
  it("maps Ceph health states to platform health", () => {
    expect(cephHealthToState("HEALTH_OK")).toBe(HealthState.Healthy);
    expect(cephHealthToState("HEALTH_WARN")).toBe(HealthState.Degraded);
    expect(cephHealthToState("HEALTH_ERR")).toBe(HealthState.Unhealthy);
    expect(cephHealthToState("something-else")).toBe(HealthState.Unknown);
  });

  it("parses total and available capacity from ceph df", () => {
    expect(
      parseCephCapacity(
        JSON.stringify({
          stats: {
            total_bytes: 10_000,
            total_avail_bytes: 4_000,
          },
        }),
      ),
    ).toEqual({ totalBytes: 10_000n, availableBytes: 4_000n });
  });

  it("maps a logical /rp path underneath the configured CephFS mount", () => {
    expect(
      resolveCephFsLocalPath(
        "/mnt/cephfs",
        "/rp",
        "/rp/volumes/tenant-a/volume-a",
      ),
    ).toBe("/mnt/cephfs/rp/volumes/tenant-a/volume-a");
  });

  it("rejects a logical path that escapes the backend base path", () => {
    expect(() =>
      resolveCephFsLocalPath(
        "/mnt/cephfs",
        "/rp",
        "/rp/volumes/../..//outside",
      ),
    ).toThrow("outside StorageBackend basePath");
  });

  it("builds Docker local-driver options for NFS-Ganesha", () => {
    expect(
      buildNfsDriverOptions(
        "10.0.0.15",
        "4.1",
        "/rp/volumes/tenant-a/volume-a",
      ),
    ).toEqual({
      type: "nfs",
      o: "addr=10.0.0.15,nfsvers=4.1,rw",
      device: ":/rp/volumes/tenant-a/volume-a",
    });
  });
});
