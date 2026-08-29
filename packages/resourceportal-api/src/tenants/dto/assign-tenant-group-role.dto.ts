import { IsString } from "class-validator";

export class AssignTenantGroupRoleDto {
  @IsString()
  roleId!: string;
}
