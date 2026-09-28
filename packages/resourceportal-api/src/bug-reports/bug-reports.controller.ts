import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { Authenticated } from "../auth/authenticated.decorator";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthenticatedUser } from "../auth/types";
import { BugReportsService } from "./bug-reports.service";
import { CreateBugReportDto } from "./dto/create-bug-report.dto";

@Controller("bug-reports")
@Authenticated()
export class BugReportsController {
  constructor(private readonly reports: BugReportsService) {}

  @Post()
  create(@Body() dto: CreateBugReportDto, @CurrentUser() actor: AuthenticatedUser | undefined) {
    if (!actor) throw new ForbiddenException("Authenticated user is required");
    return this.reports.create(dto, actor);
  }
}
