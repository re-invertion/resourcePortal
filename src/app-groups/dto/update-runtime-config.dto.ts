import { Type } from "class-transformer";
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

export const RUNTIME_CONFIG_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class UpsertSingleAppSecretDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(RUNTIME_CONFIG_NAME_PATTERN)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  value!: string;
}

export class UpdateRuntimeConfigDto {
  @IsOptional()
  @IsObject()
  environment?: Record<string, string | null>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertSingleAppSecretDto)
  secrets?: UpsertSingleAppSecretDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @Matches(RUNTIME_CONFIG_NAME_PATTERN, { each: true })
  removeSecrets?: string[];
}
