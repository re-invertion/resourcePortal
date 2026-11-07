import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AppConsumersController } from "./app-consumers.controller";
import { AppConsumerActionController } from "./app-consumer-action.controller";
import { AppConsumerActionService } from "./app-consumer-action.service";
import { AppConsumersService } from "./app-consumers.service";

@Module({
  imports: [PrismaModule],
  controllers: [AppConsumersController, AppConsumerActionController],
  providers: [AppConsumersService, AppConsumerActionService],
  exports: [AppConsumersService],
})
export class AppConsumersModule {}
