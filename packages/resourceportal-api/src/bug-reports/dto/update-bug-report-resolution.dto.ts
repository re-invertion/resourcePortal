import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateBugReportResolutionDto {
  @IsBoolean()
  resolved!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolutionNote?: string;
}