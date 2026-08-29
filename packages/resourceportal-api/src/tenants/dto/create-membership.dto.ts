import { ArrayNotEmpty, IsArray, IsString, IsUUID } from "class-validator";

export class CreateMembershipDto {
  @IsUUID()
  userId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roleIds!: string[];
}
