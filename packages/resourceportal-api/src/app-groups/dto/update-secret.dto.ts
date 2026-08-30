import { SecretType } from "@prisma/client";
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { SECRET_NAME_PATTERN } from "./create-secret.dto";

export class UpdateSecretDto {
  @IsOptional()
  @IsString()
  @Matches(SECRET_NAME_PATTERN)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(SecretType)
  type?: SecretType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(90000)
  value?: string;
}
