import { IsInt, IsNumber, IsOptional, Min } from "class-validator";

export class UpdateQuotaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  cpu?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  memoryBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  gpu?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  storageBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxSingleApps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxVolumes?: number;
}
