import { AttachmentMode } from "@prisma/client";
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

export class AttachVolumeDto {
  @IsUUID()
  volumeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^\//)
  mountPath!: string;

  @IsEnum(AttachmentMode)
  mode!: AttachmentMode;
}
