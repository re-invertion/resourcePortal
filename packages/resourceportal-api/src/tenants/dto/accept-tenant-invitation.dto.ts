import { IsString, MinLength } from "class-validator";

export class AcceptTenantInvitationDto {
  @IsString()
  @MinLength(32)
  token!: string;
}
