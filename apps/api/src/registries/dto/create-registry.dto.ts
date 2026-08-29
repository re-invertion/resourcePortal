import { RegistryAuthType, RegistryTlsMode } from "@prisma/client";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from "class-validator";

export class CreateRegistryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @IsOptional()
  @IsEnum(RegistryTlsMode)
  tlsMode?: RegistryTlsMode;

  @IsOptional()
  @IsEnum(RegistryAuthType)
  authType?: RegistryAuthType;

  @ValidateIf((dto: CreateRegistryDto) => dto.authType !== RegistryAuthType.None)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @ValidateIf((dto: CreateRegistryDto) => dto.authType !== RegistryAuthType.None)
  @IsString()
  @IsNotEmpty()
  credential?: string;
}
