import { IsIn, IsOptional, IsString, Length, MaxLength } from "class-validator";

export const BUG_REPORT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export class CreateBugReportDto {
  @IsString()
  @Length(5, 4000)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_300_000)
  imageData?: string;

  @IsOptional()
  @IsIn(BUG_REPORT_IMAGE_MIME_TYPES)
  imageMimeType?: (typeof BUG_REPORT_IMAGE_MIME_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  imageFileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}