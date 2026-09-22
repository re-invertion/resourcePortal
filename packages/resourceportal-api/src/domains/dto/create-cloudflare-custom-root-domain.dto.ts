import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

export class CreateCloudflareCustomRootDomainDto {
  @IsString()
  @Matches(/^[a-f0-9]{32}$/i, { message: "zoneId must be a 32-character Cloudflare zone identifier" })
  zoneId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  rootDomain!: string;
}
