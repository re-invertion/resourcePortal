import { DocumentBuilder } from "@nestjs/swagger";

export function buildSwaggerConfig(authModeRaw: string | undefined) {
  const authMode = (authModeRaw ?? "dev").trim().toLowerCase();
  let builder = new DocumentBuilder()
    .setTitle("Resource Portal API")
    .setDescription("Backend API for Resource Portal")
    .setVersion("0.2.0");

  if (authMode === "dev") {
    builder = builder
      .addApiKey(
        {
          type: "apiKey",
          name: "x-dev-user-id",
          in: "header",
          description: "Development authentication user id",
        },
        "dev-user",
      )
      .addSecurityRequirements("dev-user");
  } else {
    builder = builder
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
      .addSecurityRequirements("oidc")
      .addSecurityRequirements("rp_session");
  }

  return builder
    .addTag("auth")
    .addTag("users")
    .addTag("tenants")
    .addTag("app-groups")
    .addTag("registries")
    .addTag("volumes")
    .addTag("domains")
    .build();
}
