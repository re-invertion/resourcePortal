import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @MaxLength(200000)
  content!: string;
}
