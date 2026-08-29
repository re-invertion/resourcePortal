import { IdentityProviderProtocol } from "@prisma/client";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from "class-validator";

export class CreateIdentityProviderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsEnum(IdentityProviderProtocol)
  protocol!: IdentityProviderProtocol;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(200)
  issuer?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(200)
  metadataUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  clientId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  clientSecret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  scopes?: string[];

  @IsOptional()
  @IsBoolean()
  usePkce?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
