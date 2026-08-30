import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";

export class AuditLogFiltersDto {
  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actor?: string;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsString()
  result?: string;

  @IsOptional()
  @IsString()
  requestId?: string;

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ListAuditLogDto extends AuditLogFiltersDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}

export class ExportAuditLogDto extends AuditLogFiltersDto {
  @IsOptional()
  @IsIn(["json", "csv"])
  format: "json" | "csv" = "json";
}
