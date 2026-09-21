import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class LoginQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsUUID()
  identityProviderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  returnTo?: string;
}

export class LoginProvidersQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
