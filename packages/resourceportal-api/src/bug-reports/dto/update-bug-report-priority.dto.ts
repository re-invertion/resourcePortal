import { BugReportPriority } from "@prisma/client";
import { IsEnum } from "class-validator";

export class UpdateBugReportPriorityDto {
  @IsEnum(BugReportPriority)
  priority!: BugReportPriority;
}
