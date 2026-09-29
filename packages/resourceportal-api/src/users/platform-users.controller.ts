import { Controller, Get, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { UsersService } from "./users.service";

@Controller("platform/users")
@UseGuards(PlatformAdminGuard)
export class PlatformUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  listUsers() {
    return this.usersService.listUsers();
  }
}
