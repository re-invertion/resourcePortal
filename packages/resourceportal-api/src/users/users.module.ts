import { Module } from "@nestjs/common";
import { InternalAuthGuard } from "../internal/internal-auth.guard";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersController } from "./users.controller";
import { PlatformUsersController } from "./platform-users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [PrismaModule],
  controllers: [UsersController, PlatformUsersController],
  providers: [InternalAuthGuard, PlatformAdminGuard, UsersService],
})
export class UsersModule {}
