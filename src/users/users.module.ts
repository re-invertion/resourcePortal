import { Module } from "@nestjs/common";
import { InternalAuthGuard } from "../internal/internal-auth.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [InternalAuthGuard, UsersService],
})
export class UsersModule {}
