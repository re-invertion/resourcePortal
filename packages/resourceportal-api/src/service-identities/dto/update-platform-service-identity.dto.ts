import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdatePlatformServiceIdentityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsIn(["Active", "Suspended"])
  status?: "Active" | "Suspended";
}
