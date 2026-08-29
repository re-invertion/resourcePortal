import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateTenantGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
