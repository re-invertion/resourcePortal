import { describe, expect, it } from "vitest";
import { buildSwaggerConfig } from "./swagger-config";

describe("buildSwaggerConfig", () => {
  it("documents x-dev-user-id only when dev auth is actually active", () => {
    const document = buildSwaggerConfig("dev");
    expect(document.components?.securitySchemes).toHaveProperty("dev-user");
    expect(document.components?.securitySchemes).not.toHaveProperty("oidc");
    expect(JSON.stringify(document)).toContain("x-dev-user-id");
  });

  it("does not expose development impersonation in Zitadel/OIDC documentation", () => {
    const document = buildSwaggerConfig("zitadel");
    expect(document.components?.securitySchemes).not.toHaveProperty("dev-user");
    expect(document.components?.securitySchemes).toHaveProperty("oidc");
    expect(document.components?.securitySchemes).toHaveProperty("rp_session");
    expect(JSON.stringify(document)).not.toContain("x-dev-user-id");
  });
});
