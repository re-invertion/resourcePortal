import { BadRequestException } from "@nestjs/common";

const maxLogoBytes = 128 * 1024;
export function validatedTenantLogo(value: string | null | undefined) {
  if (value == null) return value;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || value.length > 180_000) {
    throw new BadRequestException("Tenant logo must be a PNG, JPEG or WebP image up to 128 KiB");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > maxLogoBytes || bytes.toString("base64") !== match[2]) {
    throw new BadRequestException("Tenant logo is invalid or too large");
  }
  const png = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const jpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
  const webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!(match[1] === "png" && png || match[1] === "jpeg" && jpeg || match[1] === "webp" && webp)) {
    throw new BadRequestException("Tenant logo content does not match the declared image format");
  }
  return value;
}
