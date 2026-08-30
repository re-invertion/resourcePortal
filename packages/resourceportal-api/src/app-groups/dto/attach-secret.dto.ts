import { IsOptional, IsString, IsUUID, Matches } from "class-validator";
import { SECRET_NAME_PATTERN } from "./create-secret.dto";

export class AttachSecretDto {
  @IsUUID()
  secretId!: string;

  @IsOptional()
  @IsString()
  @Matches(SECRET_NAME_PATTERN)
  targetName?: string;
}
