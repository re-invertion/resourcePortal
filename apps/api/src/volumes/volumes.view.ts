import { Volume, VolumeAttachment } from "@prisma/client";

type VolumeWithAttachments = Volume & {
  attachments?: VolumeAttachment[];
};

export function mapVolume(volume: VolumeWithAttachments) {
  return {
    ...volume,
    sizeBytes: volume.sizeBytes.toString(),
    usedSizeBytes: volume.usedSizeBytes?.toString() ?? null,
    attachmentCount: volume.attachments?.length,
  };
}
