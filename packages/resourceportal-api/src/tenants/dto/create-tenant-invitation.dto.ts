import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsString,
  MaxLength,
} from "class-validator";

export class CreateTenantInvitationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roleIds!: string[];
}
