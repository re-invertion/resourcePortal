import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { connectWithTransientRetry } from "./database-connectivity";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    const attempts = Math.max(
      1,
      Number.parseInt(process.env.PRISMA_CONNECT_RETRY_ATTEMPTS ?? "30", 10) ||
        30,
    );
    const delayMs = Math.max(
      100,
      Number.parseInt(
        process.env.PRISMA_CONNECT_RETRY_DELAY_MS ?? "2000",
        10,
      ) || 2000,
    );
    await connectWithTransientRetry(() => this.$connect(), {
      attempts,
      delayMs,
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
