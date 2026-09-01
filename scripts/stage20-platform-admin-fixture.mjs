export async function prepareStage20PlatformAdmin({
  prisma,
  state,
  keycloakOrigin,
  zitadelOrigin,
}) {
  const adminUserId = requireEnv("FEDERATION_E2E_ADMIN_USER_ID");
  const managementToken = requireEnv("ZITADEL_MANAGEMENT_TOKEN");
  const organizationId = requireEnv("ZITADEL_ORGANIZATION_ID");

  const existing = await prisma.userIdentity.findFirst({
    where: {
      userId: adminUserId,
      issuer: zitadelOrigin,
      identityProviderId: state.oidcProviderId,
    },
  });
  if (existing) return existing;

  const keycloakToken = await getKeycloakAdminToken(keycloakOrigin);
  const keycloakUser = await getKeycloakUser(
    keycloakOrigin,
    keycloakToken,
    state.oidcUser.username,
  );

  const imported = await zitadelRequest({
    zitadelOrigin,
    managementToken,
    organizationId,
    method: "POST",
    path: "/management/v1/users/human/_import",
    body: {
      userName: `stage20-platform-admin-${Date.now()}`,
      profile: {
        firstName: "Stage20",
        lastName: "Platform Admin",
        displayName: "Stage20 Platform Admin",
        preferredLanguage: "en",
      },
      email: { email: state.oidcUser.email, isEmailVerified: true },
      password: "FederationLocalPass123!",
      passwordChangeRequired: false,
    },
  });
  assert(imported.userId, "ZITADEL platform-admin import did not return a user id");

  await zitadelRequest({
    zitadelOrigin,
    managementToken,
    organizationId,
    method: "POST",
    path: `/v2/users/${encodeURIComponent(imported.userId)}/links`,
    body: {
      idpLink: {
        idpId: state.oidcZitadelProviderId,
        userId: keycloakUser.id,
        userName: state.oidcUser.username,
      },
    },
  });

  return prisma.userIdentity.create({
    data: {
      userId: adminUserId,
      providerType: "zitadel",
      identityProviderId: state.oidcProviderId,
      issuer: zitadelOrigin,
      externalSubject: imported.userId,
      email: state.oidcUser.email,
    },
  });
}

async function getKeycloakAdminToken(keycloakOrigin) {
  const response = await fetch(
    `${keycloakOrigin}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: "admin",
      }),
    },
  );
  const body = await response.json();
  assert(response.ok && body.access_token, "Unable to obtain Keycloak admin token");
  return body.access_token;
}

async function getKeycloakUser(keycloakOrigin, token, username) {
  const response = await fetch(
    `${keycloakOrigin}/admin/realms/tenant/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const text = await response.text();
  assert(response.ok, `Keycloak user lookup failed with ${response.status}: ${text}`);
  const users = JSON.parse(text);
  const user = users.find((candidate) => candidate.username === username);
  assert(user?.id, `Keycloak user ${username} was not found`);
  return user;
}

async function zitadelRequest({
  zitadelOrigin,
  managementToken,
  organizationId,
  method,
  path,
  body,
}) {
  const response = await fetch(`${zitadelOrigin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${managementToken}`,
      "content-type": "application/json",
      "x-zitadel-orgid": organizationId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ZITADEL ${method} ${path} failed with ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
