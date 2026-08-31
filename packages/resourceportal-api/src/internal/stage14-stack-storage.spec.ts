import { describe, expect, it, vi } from "vitest";
import { renderStackStorageVolumes } from "./stack-storage";

describe("Stage 14 stack storage rendering", () => {
  it("renders attached Volumes as Docker local-driver NFS definitions", () => {
    const runtimeDefinition = vi.fn(() => ({
      driver: "local" as const,
      driver_opts: {
        type: "nfs" as const,
        o: "addr=10.0.0.15,nfsvers=4.1,rw",
        device: ":/rp/volumes/tenant-a/volume-a",
      },
    }));

    expect(
      renderStackStorageVolumes(
        [
          {
            volumeName: "app-data",
            storagePath: "/rp/volumes/tenant-a/volume-a",
            dockerVolumeName: "rp_vol_volume_a",
          },
        ],
        runtimeDefinition,
      ),
    ).toEqual({
      rp_app_data: {
        name: "rp_vol_volume_a",
        driver: "local",
        driver_opts: {
          type: "nfs",
          o: "addr=10.0.0.15,nfsvers=4.1,rw",
          device: ":/rp/volumes/tenant-a/volume-a",
        },
      },
    });
    expect(runtimeDefinition).toHaveBeenCalledWith(
      "/rp/volumes/tenant-a/volume-a",
    );
  });

  it("does not mark Stage 14 volumes as external", () => {
    const rendered = renderStackStorageVolumes(
      [
        {
          volumeName: "data",
          storagePath: "/rp/volumes/tenant-a/volume-a",
        },
      ],
      () => ({
        driver: "local",
        driver_opts: {
          type: "nfs",
          o: "addr=nfs.internal,nfsvers=4.1,rw",
          device: ":/rp/volumes/tenant-a/volume-a",
        },
      }),
    );

    expect(rendered?.rp_data).not.toHaveProperty("external");
  });
});
