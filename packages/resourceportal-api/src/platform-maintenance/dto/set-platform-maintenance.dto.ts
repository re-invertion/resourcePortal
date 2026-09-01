import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class SetPlatformMaintenanceDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
