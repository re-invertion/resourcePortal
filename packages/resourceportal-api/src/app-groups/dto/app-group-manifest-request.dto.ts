import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { APP_GROUP_MANIFEST_MAX_BYTES } from "../app-group-manifest";

export class AppGroupManifestRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(APP_GROUP_MANIFEST_MAX_BYTES)
  yaml!: string;
}
