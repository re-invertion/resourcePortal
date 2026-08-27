import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class FailDeploymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  workerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  errorCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string;
}
