import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateTenantGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
