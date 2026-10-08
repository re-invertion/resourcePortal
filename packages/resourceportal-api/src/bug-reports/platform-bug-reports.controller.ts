import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Body,
  StreamableFile,
  UseGuards,
  Res,
} from "@nestjs/common";
import { FastifyReply } from "fastify";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import type { AuthenticatedUser } from "../auth/types";
import { BugReportsService } from "./bug-reports.service";
import { CreateBugReportDto } from "./dto/create-bug-report.dto";
import { UpdateBugReportPriorityDto } from "./dto/update-bug-report-priority.dto";
import { UpdateBugReportResolutionDto } from "./dto/update-bug-report-resolution.dto";

@Controller("platform/bug-reports")
@UseGuards(PlatformAdminGuard)
export class PlatformBugReportsController {
  constructor(private readonly reports: BugReportsService) {}

  @Get()
  list() {
    return this.reports.list();
  }

  @Post()
  create(
    @Body() dto: CreateBugReportDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reports.create(dto, actor);
  }

  @Patch(":id/priority")
  updatePriority(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBugReportPriorityDto,
  ) {
    return this.reports.setPriority(id, dto.priority);
  }

  @Patch(":id/resolution")
  updateResolution(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBugReportResolutionDto,
  ) {
    return this.reports.setResolved(id, dto.resolved, dto.resolutionNote);
  }

  @Get(":id/image")
  async image(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const image = await this.reports.getImage(id);
    reply.header("content-type", image.mimeType);
    reply.header(
      "content-disposition",
      `inline; filename="${safeHeaderFileName(image.fileName)}"`,
    );
    reply.header("cache-control", "private, no-store");
    return new StreamableFile(image.data);
  }
}

function safeHeaderFileName(value: string) {
  return value.replace(/[\\"\r\n]/g, "_").slice(0, 180) || "bug-report-image";
}