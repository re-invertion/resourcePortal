import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 3000);

  const cookieSecret = getCookieSecret(config);
  await app.register(
    fastifyCookie,
    cookieSecret
      ? {
          secret: cookieSecret,
        }
      : undefined,
  );

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
    .addCookieAuth(
      "rp_session",
      {
        type: "apiKey",
        in: "cookie",
        name: "rp_session",
        description: "Browser session cookie created by the OIDC callback",
      },
      "rp_session",
    )
    .addSecurityRequirements("dev-user")
    .addSecurityRequirements("oidc")
    .addSecurityRequirements("rp_session")
    .addTag("auth")
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

function getCookieSecret(config: ConfigService) {
  const secret = config.get<string>("AUTH_COOKIE_SECRET");
  const authMode = config.get<string>("AUTH_MODE", "dev").toLowerCase();

  if (secret) {
    return secret;
  }

  if (authMode === "oidc" || authMode === "zitadel") {
    throw new Error("AUTH_COOKIE_SECRET is required when AUTH_MODE uses OIDC");
  }

  return undefined;
}

void bootstrap();
