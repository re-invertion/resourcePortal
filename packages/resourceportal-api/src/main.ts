import { Logger, RequestMethod, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import { FastifyReply, FastifyRequest } from "fastify";
import { SwaggerModule } from "@nestjs/swagger";
import { ApiModule } from "./api.module";
import { apiTrustProxy } from "./config/http-proxy-config";
import { buildSwaggerConfig } from "./config/swagger-config";
import { ObservabilityService } from "./observability/observability.service";
import { structuredLog } from "./observability/structured-log";
import { ServerSpan, TracingService } from "./observability/tracing.service";
import { RateLimitService } from "./security/rate-limit.service";
import { shouldRateLimitRequest } from "./security/rate-limit-policy";

type ObservedRequest = FastifyRequest & {
  requestId?: string;
  correlationId?: string;
  requestStartedAt?: number;
  traceSpan?: ServerSpan;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({
      trustProxy: apiTrustProxy(
        process.env.NODE_ENV,
        process.env.API_TRUST_PROXY_HOPS,
      ),
    }),
  );
  const config = app.get(ConfigService);
  const observability = app.get(ObservabilityService);
  const tracing = app.get(TracingService);
  const rateLimit = app.get(RateLimitService);
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

  app.setGlobalPrefix("api", {
    exclude: [
      {
        path: ".well-known/oauth-protected-resource/api/tenants/:mcpTenantId/mcp",
        method: RequestMethod.GET,
      },
    ],
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", async (request: ObservedRequest, reply) => {
    const requestId = idFromHeader(request.headers["x-request-id"]);
    const correlationId = idFromHeader(request.headers["x-correlation-id"]);
    const traceSpan = tracing.startServerSpan(
      request.headers.traceparent,
      `${request.method} ${request.url.split("?")[0] ?? request.url}`,
    );

    request.requestId = requestId;
    request.correlationId = correlationId;
    request.requestStartedAt = Date.now();
    request.traceSpan = traceSpan;
    reply.header("x-request-id", requestId);
    reply.header("x-correlation-id", correlationId);
    reply.header("traceparent", traceSpan.traceparent);
    applySecurityHeaders(request, reply, config);

    if (shouldRateLimitRequest(request.url)) {
      const limit = await rateLimit.consume(request.ip);
      reply.header("x-ratelimit-limit", String(limit.limit));
      reply.header("x-ratelimit-remaining", String(limit.remaining));
      reply.header("x-ratelimit-reset", String(Math.ceil(limit.resetAt / 1000)));
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds));
        reply.status(429).send({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests",
            statusCode: 429,
            requestId,
            details: {
              retryAfterSeconds: limit.retryAfterSeconds,
            },
          },
        });
        return;
      }
    }

    if (!isCsrfValid(request, config)) {
      reply.status(403).send({
        error: {
          code: "CSRF_INVALID",
          message: "CSRF token is missing or invalid",
          statusCode: 403,
          requestId,
          details: null,
        },
      });
      return;
    }

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
    if (request.traceSpan) {
      void tracing.finishServerSpan(request.traceSpan, {
        method: request.method,
        route,
        statusCode: reply.statusCode,
      });
    }
    structuredLog(httpLogger, "log", "resource-portal-api", "http.request", {
      requestId: request.requestId ?? null,
      correlationId: request.correlationId ?? null,
      traceId: request.traceSpan?.traceId ?? null,
      spanId: request.traceSpan?.spanId ?? null,
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
      remoteAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    done();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = buildSwaggerConfig(config.get<string>("AUTH_MODE"));
  const swaggerDocumentFactory = () =>
    SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, swaggerDocumentFactory, {
    useGlobalPrefix: true,
    jsonDocumentUrl: "openapi.json",
  });

  await app.listen({ host: "0.0.0.0", port });
  const bootstrapLogger = new Logger("ResourcePortalApi");
  structuredLog(bootstrapLogger, "log", "resource-portal-api", "api.started", {
    port,
    basePath: "/api",
  });
  structuredLog(bootstrapLogger, "log", "resource-portal-api", "api.swagger.ready", {
    path: "/api/docs",
  });
}

void bootstrap();

function idFromHeader(value: string | string[] | undefined) {
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

function applySecurityHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ConfigService,
) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");

  if (!request.url.startsWith("/api/docs")) {
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
    );
  }

  if (config.get<string>("NODE_ENV") === "production") {
    reply.header(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

function isCsrfValid(request: FastifyRequest, config: ConfigService) {
  if (!unsafeMethods.has(request.method.toUpperCase())) {
    return true;
  }

  const sessionCookieName = config.get<string>(
    "AUTH_SESSION_COOKIE_NAME",
    "rp_session",
  );
  if (!request.cookies[sessionCookieName]) {
    return true;
  }

  const csrfCookieName = config.get<string>("AUTH_CSRF_COOKIE_NAME", "rp_csrf");
  const cookieToken = request.cookies[csrfCookieName];
  const headerValue = request.headers["x-csrf-token"];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!cookieToken || !headerToken) {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  return (
    cookieBuffer.length === headerBuffer.length &&
    timingSafeEqual(cookieBuffer, headerBuffer)
  );
}
