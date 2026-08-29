import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class ClaimDeploymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  workerId!: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(3600)
  leaseSeconds?: number;
}
