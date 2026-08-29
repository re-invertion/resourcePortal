import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 3000);

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Resource Portal API")
    .setDescription("Backend API for Resource Portal")
    .setVersion("0.1.0")
    .addApiKey(
      {
        type: "apiKey",
        name: "x-dev-user-id",
        in: "header",
        description: "Development authentication user id",
      },
      "dev-user",
    )
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "OIDC access token",
      },
      "oidc",
    )
    .addSecurityRequirements("dev-user")
    .addSecurityRequirements("oidc")
    .addTag("users")
    .addTag("tenants")
    .addTag("app-groups")
    .addTag("registries")
    .addTag("volumes")
    .addTag("domains")
    .build();
  const swaggerDocumentFactory = () =>
    SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, swaggerDocumentFactory, {
    useGlobalPrefix: true,
    jsonDocumentUrl: "openapi.json",
  });

  await app.listen({ host: "0.0.0.0", port });
  Logger.log(`Resource Portal API listening on http://localhost:${port}/api`);
  Logger.log(`Swagger UI available at http://localhost:${port}/api/docs`);
}

void bootstrap();
