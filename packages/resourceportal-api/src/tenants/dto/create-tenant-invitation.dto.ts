import {
  IsArray,
  IsEmail,
  IsOptional,
  ArrayUnique,
  IsUUID,
  IsString,
  MaxLength,
} from "class-validator";

export class CreateTenantInvitationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsArray()
  @IsString({ each: true })
  roleIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID("4", { each: true })
  oauthApplicationIds?: string[];
}
