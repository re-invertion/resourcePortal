import { IsBoolean, IsOptional } from "class-validator";

export class UpdateTenantAuthPolicyDto {
  @IsOptional()
  @IsBoolean()
  allowPlatformLogin?: boolean;

  @IsOptional()
  @IsBoolean()
  allowTenantIdentityProviders?: boolean;

  @IsOptional()
  @IsBoolean()
  requireTenantIdentityProvider?: boolean;
}
