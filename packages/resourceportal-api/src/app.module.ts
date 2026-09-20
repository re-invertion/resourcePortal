import { Module } from "@nestjs/common";
import { ApiModule } from "./api.module";

/** @deprecated Import ApiModule for HTTP or WorkerModule for background execution. */
@Module({ imports: [ApiModule] })
export class AppModule {}
