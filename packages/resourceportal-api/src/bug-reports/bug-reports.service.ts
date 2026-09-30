import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BugReportPriority } from "@prisma/client";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import {
  BUG_REPORT_IMAGE_MIME_TYPES,
  CreateBugReportDto,
} from "./dto/create-bug-report.dto";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

type AllowedMime = (typeof BUG_REPORT_IMAGE_MIME_TYPES)[number];

@Injectable()
export class BugReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateBugReportDto, actor: AuthenticatedUser) {
    const image = decodeImage(dto);
    const report = await this.prisma.bugReport.create({
      data: {
        description: dto.description.trim(),
        reportedById: actor.id,
        imageData: image?.data,
        imageMimeType: image?.mimeType,
        imageFileName: image?.fileName,
        url: dto.url?.trim() || null,
      },
      select: { id: true, priority: true, createdAt: true },
    });

    return report;
  }

  async list() {
    const reports = await this.prisma.bugReport.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        reportedBy: { select: { id: true, email: true, displayName: true } },
      },
    });

    return reports.map((report) => ({
      id: report.id,
      description: report.description,
      priority: report.priority,
      resolved: Boolean(report.resolvedAt),
      resolvedAt: report.resolvedAt,
      reporter: report.reportedBy,
      hasImage: Boolean(report.imageData),
      imageMimeType: report.imageMimeType,
      imageFileName: report.imageFileName,
      url: report.url,
      resolutionNote: report.resolutionNote,
      imageUrl: report.imageData
        ? `/api/platform/bug-reports/${report.id}/image`
        : null,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    }));
  }

  async setPriority(id: string, priority: BugReportPriority) {
    const exists = await this.prisma.bugReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException("Bug report was not found");

    const report = await this.prisma.bugReport.update({
      where: { id },
      data: { priority },
      include: {
        reportedBy: { select: { id: true, email: true, displayName: true } },
      },
    });

    return {
      id: report.id,
      description: report.description,
      priority: report.priority,
      resolved: Boolean(report.resolvedAt),
      resolvedAt: report.resolvedAt,
      reporter: report.reportedBy,
      hasImage: Boolean(report.imageData),
      imageMimeType: report.imageMimeType,
      imageFileName: report.imageFileName,
      url: report.url,
      resolutionNote: report.resolutionNote,
      imageUrl: report.imageData
        ? `/api/platform/bug-reports/${report.id}/image`
        : null,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  async setResolved(id: string, resolved: boolean, resolutionNote?: string) {
    const exists = await this.prisma.bugReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException("Bug report was not found");

    const report = await this.prisma.bugReport.update({
      where: { id },
      data: {
        resolvedAt: resolved ? new Date() : null,
        resolutionNote: resolved ? resolutionNote?.trim() || null : null,
      },
      include: {
        reportedBy: { select: { id: true, email: true, displayName: true } },
      },
    });

    return {
      id: report.id,
      description: report.description,
      priority: report.priority,
      resolved: Boolean(report.resolvedAt),
      resolvedAt: report.resolvedAt,
      reporter: report.reportedBy,
      hasImage: Boolean(report.imageData),
      imageMimeType: report.imageMimeType,
      imageFileName: report.imageFileName,
      url: report.url,
      resolutionNote: report.resolutionNote,
      imageUrl: report.imageData
        ? `/api/platform/bug-reports/${report.id}/image`
        : null,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  async getImage(id: string) {
    const report = await this.prisma.bugReport.findUnique({
      where: { id },
      select: { imageData: true, imageMimeType: true, imageFileName: true },
    });
    if (!report) throw new NotFoundException("Bug report was not found");
    if (!report.imageData || !report.imageMimeType)
      throw new NotFoundException("Bug report has no image attachment");
    return {
      data: Buffer.from(report.imageData),
      mimeType: report.imageMimeType,
      fileName: report.imageFileName ?? "bug-report-image",
    };
  }
}

function decodeImage(dto: CreateBugReportDto) {
  if (!dto.imageData && !dto.imageMimeType && !dto.imageFileName)
    return undefined;
  if (!dto.imageData || !dto.imageMimeType) {
    throw new BadRequestException(
      "Image data and MIME type must be provided together",
    );
  }
  if (!BUG_REPORT_IMAGE_MIME_TYPES.includes(dto.imageMimeType)) {
    throw new BadRequestException("Unsupported image type");
  }
  const base64 = dto.imageData.trim();
  if (
    !base64 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new BadRequestException("Image attachment is not valid base64 data");
  }
  const data = Buffer.from(base64, "base64");
  if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
    throw new BadRequestException("Image attachment must be 3 MB or smaller");
  }
  if (!matchesImageSignature(data, dto.imageMimeType)) {
    throw new BadRequestException(
      "Image content does not match its declared type",
    );
  }
  return {
    data,
    mimeType: dto.imageMimeType,
    fileName: dto.imageFileName?.trim() || null,
  };
}

function matchesImageSignature(data: Buffer, mimeType: AllowedMime) {
  if (mimeType === "image/png")
    return data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg")
    return (
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    );
  if (mimeType === "image/gif")
    return ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  return (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  );
}