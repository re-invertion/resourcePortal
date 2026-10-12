import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from "class-validator";

export class UpdateTenantBrandingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  displayName?: string;

  // null removes the uploaded logo.
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(180_000)
  logoDataUrl?: string | null;
}
