import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class DeployAppGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
