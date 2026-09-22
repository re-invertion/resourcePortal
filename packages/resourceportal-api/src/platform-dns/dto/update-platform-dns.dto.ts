import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class UpdatePlatformDnsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{32}$/i, { message: "zoneId must be a 32-character Cloudflare zone identifier" })
  zoneId?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  apiToken?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  oauthClientId?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  oauthClientSecret?: string;
}
