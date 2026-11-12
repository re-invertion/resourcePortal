import { MembershipStatus } from "@prisma/client";
import { ArrayUnique, IsArray, IsEnum, IsOptional, IsString, IsUUID } from "class-validator";

export class UpdateMembershipDto {
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  roleIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID("4", { each: true })
  oauthApplicationIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  nativeApplicationKeys?: string[];
}
