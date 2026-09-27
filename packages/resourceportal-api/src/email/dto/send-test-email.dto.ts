import { IsEmail, MaxLength } from "class-validator";

export class SendTestEmailDto {
  @IsEmail()
  @MaxLength(320)
  recipient!: string;
}
