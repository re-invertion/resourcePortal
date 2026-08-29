import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class RollbackDeploymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
