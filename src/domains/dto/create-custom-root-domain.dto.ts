import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

export class CreateCustomRootDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  )
  rootDomain!: string;
}
