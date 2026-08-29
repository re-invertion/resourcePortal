import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class AttachConfigDto {
  @IsString()
  @IsNotEmpty()
  configId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  targetPath!: string;
}
