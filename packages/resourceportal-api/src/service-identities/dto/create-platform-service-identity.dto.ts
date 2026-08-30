import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreatePlatformServiceIdentityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
