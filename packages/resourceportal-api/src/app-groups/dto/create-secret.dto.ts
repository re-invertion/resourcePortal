import { SecretType } from "@prisma/client";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

export const SECRET_NAME_PATTERN = /^(?!\.$)(?!.*\.\.)[A-Za-z0-9_.-]{1,128}$/;

export class CreateSecretDto {
  @IsString()
  @IsNotEmpty()
  @Matches(SECRET_NAME_PATTERN)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsEnum(SecretType)
  type!: SecretType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsString()
  @MaxLength(90000)
  value!: string;
}
