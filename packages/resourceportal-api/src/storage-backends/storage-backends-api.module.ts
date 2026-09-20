import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageBackendStore } from "./storage-backend.store";
import { StorageBackendsApiService } from "./storage-backends-api.service";
import { StorageBackendsController } from "./storage-backends.controller";

@Module({
  imports: [PrismaModule, OperationsModule],
  controllers: [StorageBackendsController],
  providers: [StorageBackendStore, StorageBackendsApiService],
})
export class StorageBackendsApiModule {}
