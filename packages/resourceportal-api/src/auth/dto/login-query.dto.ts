import { IsOptional, IsUUID } from "class-validator";

export class LoginQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsUUID()
  identityProviderId?: string;
}

export class LoginProvidersQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
