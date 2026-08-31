export type StackStorageVolume = {
  volumeName: string;
  storagePath: string;
  dockerVolumeName?: string;
};

export type RuntimeVolumeDefinition = {
  driver: "local";
  driver_opts: {
    type: "nfs";
    o: string;
    device: string;
  };
};

export function renderStackStorageVolumes(
  volumes: StackStorageVolume[],
  runtimeDefinition: (storagePath: string) => RuntimeVolumeDefinition,
) {
  const definitions = new Map<
    string,
    RuntimeVolumeDefinition & { name: string }
  >();

  for (const volume of volumes) {
    const alias = `rp_${volume.volumeName.replaceAll("-", "_")}`;
    definitions.set(alias, {
      name: volume.dockerVolumeName ?? alias,
      ...runtimeDefinition(volume.storagePath),
    });
  }

  return definitions.size > 0 ? Object.fromEntries(definitions) : undefined;
}
