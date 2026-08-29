import { IdentityProviderProtocol } from "@prisma/client";
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

export class CreateIdentityProviderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsEnum(IdentityProviderProtocol)
  protocol!: IdentityProviderProtocol;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  zitadelIdentityProviderId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  issuer?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  metadataUrl?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
