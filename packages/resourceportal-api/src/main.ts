import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import { FastifyRequest } from "fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ObservabilityService } from "./observability/observability.service";

type ObservedRequest = FastifyRequest & {
  requestId?: string;
  requestStartedAt?: number;
};

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(ConfigService);
  const observability = app.get(ObservabilityService);
  const port = config.get<number>("PORT", 3000);
  const httpLogger = new Logger("HttpRequest");

  const cookieSecret = config.get<string>("AUTH_COOKIE_SECRET");
  await app.register(
    fastifyCookie,
    cookieSecret
      ? {
          secret: cookieSecret,
        }
      : undefined,
  );

  app.setGlobalPrefix("api");
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (request: ObservedRequest, reply, done) => {
    const requestId = requestIdFromHeader(request.headers["x-request-id"]);

    request.requestId = requestId;
    request.requestStartedAt = Date.now();
    reply.header("x-request-id", requestId);
    done();
  });
  fastify.addHook("onResponse", (request: ObservedRequest, reply, done) => {
    const durationMs = Date.now() - (request.requestStartedAt ?? Date.now());
    const route = routeFromRequest(request);

    observability.recordRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
    });
    httpLogger.log(
      JSON.stringify({
        event: "http.request",
        requestId: request.requestId,
        method: request.method,
        route,
        statusCode: reply.statusCode,
        durationMs,
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      }),
    );
    done();
  });
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

void bootstrap();

function requestIdFromHeader(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (candidate && candidate.length <= 128) {
    return candidate;
  }

  return randomUUID();
}

function routeFromRequest(request: FastifyRequest) {
  const routeOptions = request.routeOptions as { url?: string } | undefined;
  return routeOptions?.url ?? request.url.split("?")[0] ?? "unknown";
}
