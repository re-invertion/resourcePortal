import { describe, expect, it } from "vitest";
import {
  bootstrapWebOidcConfig,
  selectBootstrapWebOidcApp,
} from "./zitadel-web-oidc";

describe("ZITADEL Web OIDC bootstrap reconciliation", () => {
  it("selects the existing Web app by immutable client id", () => {
    const selected = selectBootstrapWebOidcApp(
      [
        {
          id: "wrong",
          name: "Resource Portal Web",
          oidcConfig: { clientId: "other" },
        },
        {
          id: "expected",
          name: "renamed",
          oidcConfig: { clientId: "client-123" },
        },
      ],
      "client-123",
    );
    expect(selected?.id).toBe("expected");
  });

  it("renders production callback and logout configuration without dev mode", () => {
    expect(
      bootstrapWebOidcConfig(
        ["https://new.example.com/api/auth/callback"],
        ["https://new.example.com/api/auth/logout/callback"],
        true,
      ),
    ).toMatchObject({
      redirectUris: ["https://new.example.com/api/auth/callback"],
      postLogoutRedirectUris: [
        "https://new.example.com/api/auth/logout/callback",
      ],
      additionalOrigins: ["https://new.example.com"],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      devMode: false,
    });
  });
});
