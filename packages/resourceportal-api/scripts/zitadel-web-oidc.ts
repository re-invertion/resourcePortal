export type BootstrapOidcApp = {
  id?: string;
  name?: string;
  oidcConfig?: { clientId?: string };
};

export function selectBootstrapWebOidcApp(
  apps: BootstrapOidcApp[],
  expectedClientId: string,
) {
  return apps.find(
    (app) => app.id && app.oidcConfig?.clientId === expectedClientId,
  );
}

export function bootstrapWebOidcConfig(
  redirectUris: string[],
  postLogoutRedirectUris: string[],
  production: boolean,
) {
  const additionalOrigins = Array.from(
    new Set(
      [...redirectUris, ...postLogoutRedirectUris].map(
        (uri) => new URL(uri).origin,
      ),
    ),
  );
  return {
    redirectUris,
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_WEB",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
    postLogoutRedirectUris,
    additionalOrigins,
    version: "OIDC_VERSION_1_0",
    devMode: !production,
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    idTokenUserinfoAssertion: true,
  };
}
