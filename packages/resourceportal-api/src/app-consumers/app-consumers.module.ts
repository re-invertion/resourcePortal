import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AppConsumersController, MembershipAppGrantsController } from "./app-consumers.controller";
import { AppConsumerActionController } from "./app-consumer-action.controller";
import { AppConsumerActionService } from "./app-consumer-action.service";
import { AppConsumersService } from "./app-consumers.service";
import { McpDcrClientVerifierService } from "./mcp-dcr-client-verifier.service";

@Module({
  imports: [PrismaModule],
  controllers: [MembershipAppGrantsController, AppConsumersController, AppConsumerActionController],
  providers: [AppConsumersService, AppConsumerActionService, McpDcrClientVerifierService],
  exports: [AppConsumersService],
})
export class AppConsumersModule {}
