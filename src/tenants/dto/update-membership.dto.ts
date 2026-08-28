import { MembershipStatus } from "@prisma/client";
import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString } from "class-validator";

export class UpdateMembershipDto {
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roleIds?: string[];
}
