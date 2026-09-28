import { IsBoolean } from "class-validator";

export class UpdateBugReportResolutionDto {
  @IsBoolean()
  resolved!: boolean;
}
