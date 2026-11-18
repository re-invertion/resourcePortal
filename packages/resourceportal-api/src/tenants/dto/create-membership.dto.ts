import { IsArray, IsString, IsUUID } from "class-validator";

export class CreateMembershipDto {
  @IsUUID()
  userId!: string;

  @IsArray()
  @IsString({ each: true })
  roleIds!: string[];
}
