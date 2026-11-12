import { MembershipStatus } from "@prisma/client";
import { ArrayUnique, IsArray, IsEnum, IsOptional, IsString } from "class-validator";

export class UpdateMembershipDto {
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  roleIds?: string[];
}
