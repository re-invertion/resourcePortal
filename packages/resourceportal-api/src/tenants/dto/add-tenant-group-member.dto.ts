import { IsUUID } from "class-validator";

export class AddTenantGroupMemberDto {
  @IsUUID()
  membershipId!: string;
}
