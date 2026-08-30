import { PrismaClient, UserStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const prisma = new PrismaClient();
const apiUrl = (process.env.FEDERATION_E2E_API_URL ?? "http://localhost:3000/api").replace(/\/$/, "");
const zitadelUrl = (process.env.OIDC_ISSUER_URL ?? "http://localhost:8080").replace(/\/$/, "");
const keycloakUrl = (process.env.FEDERATION_E2E_KEYCLOAK_URL ?? "http://localhost:8180").replace(/\/$/, "");
const organizationId = requireEnv("ZITADEL_ORGANIZATION_ID");
const managementToken = requireEnv("ZITADEL_MANAGEMENT_TOKEN");
const statePath = resolve(process.env.FEDERATION_E2E_STATE_FILE ?? "../../var/federation/state.json");
const policyAssertAttempts = 40;
const policyAssertDelayMs = 250;
const loginPolicyEventTypes = [
  "org.policy.login.added",
  "org.policy.login.changed",
] as const;

const writableLoginPolicyFields = [
  "allowUsernamePassword",
  "allowRegister",
  "forceMfa",
  "passwordlessType",
  "hidePasswordReset",
  "ignoreUnknownUsernames",
  "defaultRedirectUri",
  "passwordCheckLifetime",
  "externalLoginCheckLifetime",
  "mfaInitSkipLifetime",
  "secondFactorCheckLifetime",
  "multiFactorCheckLifetime",
  "secondFactors",
  "multiFactors",
  "allowDomainDiscovery",
  "disableLoginWithEmail",
  "disableLoginWithPhone",
  "forceMfaLocalOnly",
] as const;

type ProviderResponse = {
  id: string;
  protocol: "OIDC" | "SAML";
  zitadelIdentityProviderId: string;
};

type TenantResponse = { id: string };
type LoginPolicyResponse = {
  isDefault?: boolean;
  policy?: Record<string, unknown> & { allowExternalIdp?: boolean };
};
type ZitadelEvent = {
  aggregate?: {
    id?: string;
    resourceOwner?: string;
    type?: { type?: string };
  };
  payload?: Record<string, unknown>;
  sequence?: number | string;
  type?: { type?: string };
};
type ZitadelEventsResponse = {
  events?: ZitadelEvent[];
};

async function main() {
  const devUserId = randomUUID();
  await prisma.user.create({
    data: {
      id: devUserId,
      email: "federation-admin@example.test",
      displayName: "Federation E2E Admin",
      status: UserStatus.Active,
    },
  });

  const tenant = await apiRequest<TenantResponse>("POST", "/tenants", devUserId, {
    name: `federation-${Date.now()}`,
    displayName: "Federation E2E",
    description: "Ephemeral tenant used by the live federation integration test",
    contactEmail: "federation-admin@example.test",
  });

  const oidcProvider = await apiRequest<ProviderResponse>(
    "POST",
    `/tenants/${tenant.id}/identity-providers`,
    devUserId,
    {
      name: "Tenant Keycloak OIDC",
      protocol: "OIDC",
      issuer: `${keycloakUrl}/realms/tenant`,
      clientId: "zitadel-oidc",
      clientSecret: "zitadel-oidc-secret",
      scopes: ["openid", "profile", "email"],
      usePkce: true,
      enabled: true,
    },
  );

  await assertExternalIdpAllowed(true);
  await setExternalIdpAllowed(false);
  await assertExternalIdpAllowed(false);

  const samlProvider = await apiRequest<ProviderResponse>(
    "POST",
    `/tenants/${tenant.id}/identity-providers`,
    devUserId,
    {
      name: "Tenant Keycloak SAML",
      protocol: "SAML",
      metadataUrl: `${keycloakUrl}/realms/tenant/protocol/saml/descriptor`,
      enabled: true,
    },
  );

  await assertExternalIdpAllowed(true);
  await configureKeycloakSamlClient(samlProvider.zitadelIdentityProviderId);
  await prepareSamlLinkedUser(samlProvider.zitadelIdentityProviderId);

  await apiRequest(
    "PATCH",
    `/tenants/${tenant.id}/auth-policy`,
    devUserId,
    {
      allowPlatformLogin: false,
      allowTenantIdentityProviders: true,
      requireTenantIdentityProvider: true,
    },
  );

  const providers = await fetchJson<Array<{ id: string; scope: string }>>(
    `${apiUrl}/auth/providers?tenantId=${encodeURIComponent(tenant.id)}`,
  );
  const providerIds = new Set(providers.map((provider) => provider.id));
  assert(providerIds.has(oidcProvider.id), "OIDC provider is not exposed by tenant login discovery");
  assert(providerIds.has(samlProvider.id), "SAML provider is not exposed by tenant login discovery");
  assert(providers.every((provider) => provider.scope === "Tenant"), "Non-tenant provider leaked into SSO-only login discovery");

  const unselectedLogin = await fetch(
    `${apiUrl}/auth/login?tenantId=${encodeURIComponent(tenant.id)}`,
    { redirect: "manual" },
  );
  assert(unselectedLogin.status === 403, `SSO-only tenant accepted login without a tenant IdP (${unselectedLogin.status})`);

  const state = {
    tenantId: tenant.id,
    oidcProviderId: oidcProvider.id,
    samlProviderId: samlProvider.id,
    oidcZitadelProviderId: oidcProvider.zitadelIdentityProviderId,
    samlZitadelProviderId: samlProvider.zitadelIdentityProviderId,
    oidcUser: {
      username: "oidc-user",
      email: "oidc-user@example.test",
      password: "TenantPass123!",
    },
    samlUser: {
      username: "saml-user",
      email: "saml-user@example.test",
      password: "TenantPass123!",
    },
  };

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Federation E2E provisioned tenant ${tenant.id}`);
  console.log(`OIDC provider ${oidcProvider.id} -> ZITADEL ${oidcProvider.zitadelIdentityProviderId}`);
  console.log(`SAML provider ${samlProvider.id} -> ZITADEL ${samlProvider.zitadelIdentityProviderId}`);
}

async function apiRequest<T = Record<string, unknown>>(
  method: string,
  path: string,
  devUserId: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-dev-user-id": devUserId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }

  return payload as T;
}

async function getLoginPolicy() {
  return zitadelRequest<LoginPolicyResponse>("GET", "/management/v1/policies/login");
}

async function getLoginPolicyEventState() {
  const response = await zitadelRequest<ZitadelEventsResponse>(
    "POST",
    "/admin/v1/events/_search",
    {
      asc: true,
      limit: 1000,
      aggregateId: organizationId,
      aggregateTypes: ["org"],
      resourceOwner: organizationId,
      eventTypes: [...loginPolicyEventTypes],
    },
  );

  let found = false;
  let allowExternalIdp = false;
  let lastEventType = "none";

  for (const event of response.events ?? []) {
    if (
      event.aggregate?.id !== organizationId ||
      event.aggregate?.resourceOwner !== organizationId ||
      event.aggregate?.type?.type !== "org"
    ) {
      continue;
    }

    const eventType = event.type?.type;
    if (!eventType || !loginPolicyEventTypes.includes(eventType as (typeof loginPolicyEventTypes)[number])) {
      continue;
    }

    found = true;
    lastEventType = eventType;
    if (typeof event.payload?.allowExternalIdp === "boolean") {
      allowExternalIdp = event.payload.allowExternalIdp;
    }
  }

  return { allowExternalIdp, found, lastEventType };
}

async function assertExternalIdpAllowed(expected: boolean) {
  let lastState = {
    allowExternalIdp: false,
    found: false,
    lastEventType: "none",
  };

  for (let attempt = 0; attempt < policyAssertAttempts; attempt += 1) {
    lastState = await getLoginPolicyEventState();
    if (lastState.found && lastState.allowExternalIdp === expected) {
      return;
    }

    if (attempt + 1 < policyAssertAttempts) {
      await sleep(policyAssertDelayMs);
    }
  }

  throw new Error(
    `Expected ZITADEL login-policy event state allowExternalIdp=${expected}, got found=${lastState.found}, allowExternalIdp=${lastState.allowExternalIdp}, lastEventType=${lastState.lastEventType}`,
  );
}

async function setExternalIdpAllowed(value: boolean) {
  // The management GET can lag behind the event store, but its inherited values
  // are still suitable for preserving the writable policy fields. PUT executes
  // against the command-side write model, which already contains the custom
  // policy created while provisioning the first tenant IdP.
  const current = await getLoginPolicy();
  assert(current.policy, "ZITADEL login policy is missing");

  const body: Record<string, unknown> = { allowExternalIdp: value };
  for (const field of writableLoginPolicyFields) {
    const fieldValue = current.policy[field];
    if (fieldValue !== undefined) {
      body[field] = fieldValue;
    }
  }
  body.allowExternalIdp = value;

  await zitadelRequest("PUT", "/management/v1/policies/login", body);
}

async function zitadelRequest<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${zitadelUrl}${path}`, {
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

  return (text ? JSON.parse(text) : {}) as T;
}

async function configureKeycloakSamlClient(zitadelProviderId: string) {
  const metadataResponse = await fetch(
    `${zitadelUrl}/idps/${encodeURIComponent(zitadelProviderId)}/saml/metadata`,
  );
  const metadata = await metadataResponse.text();
  if (!metadataResponse.ok) {
    throw new Error(`ZITADEL SAML SP metadata failed with ${metadataResponse.status}: ${metadata}`);
  }

  const entityId = /entityID="([^"]+)"/.exec(metadata)?.[1];
  const acsLocations = [
    ...metadata.matchAll(/AssertionConsumerService[^>]+Location="([^"]+)"/g),
  ].map((match) => match[1]);
  const redirectUris = [...new Set(acsLocations)];
  const loginAcs = redirectUris.find((location) =>
    location.endsWith("/ui/login/login/externalidp/saml/acs"),
  );

  assert(entityId, "ZITADEL SAML metadata does not contain entityID");
  assert(redirectUris.length > 0, "ZITADEL SAML metadata does not contain AssertionConsumerService Location");
  assert(loginAcs, "ZITADEL SAML metadata does not contain the login AssertionConsumerService Location");

  const tokenResponse = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: "admin",
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  assert(tokenResponse.ok && tokenPayload.access_token, "Unable to obtain Keycloak admin token");

  const clientResponse = await fetch(`${keycloakUrl}/admin/realms/tenant/clients`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clientId: entityId,
      name: "ZITADEL SAML federation",
      enabled: true,
      protocol: "saml",
      publicClient: false,
      frontchannelLogout: true,
      redirectUris,
      attributes: {
        "saml.assertion.signature": "true",
        "saml.authnstatement": "true",
        "saml.client.signature": "false",
        "saml.force.post.binding": "true",
        "saml.server.signature": "true",
        "saml.server.signature.keyinfo.ext": "false",
        "saml_force_name_id_format": "true",
        "saml_name_id_format": "email",
      },
      protocolMappers: [
        samlUserPropertyMapper("email", "email", "email"),
        samlUserPropertyMapper("firstName", "firstName", "firstName"),
        samlUserPropertyMapper("lastName", "lastName", "lastName"),
      ],
    }),
  });

  const clientText = await clientResponse.text();
  if (!clientResponse.ok && clientResponse.status !== 409) {
    throw new Error(`Keycloak SAML client creation failed with ${clientResponse.status}: ${clientText}`);
  }

  console.log(`Keycloak SAML redirects: ${redirectUris.join(", ")}`);
}

async function prepareSamlLinkedUser(zitadelProviderId: string) {
  const externalUserId = "saml-user@example.test";
  const imported = await zitadelRequest<{ userId?: string }>(
    "POST",
    "/management/v1/users/human/_import",
    {
      userName: `saml-linked-${Date.now()}`,
      profile: {
        firstName: "SAML",
        lastName: "User",
        displayName: "SAML User",
        preferredLanguage: "en",
      },
      email: {
        email: externalUserId,
        isEmailVerified: true,
      },
      password: "FederationLocalPass123!",
      passwordChangeRequired: false,
    },
  );

  assert(imported.userId, "ZITADEL SAML linked-user import did not return a user id");

  await zitadelRequest(
    "POST",
    `/v2/users/${encodeURIComponent(imported.userId)}/links`,
    {
      idpLink: {
        idpId: zitadelProviderId,
        userId: externalUserId,
        userName: externalUserId,
      },
    },
  );

  console.log(`Linked SAML external user ${externalUserId} -> ZITADEL user ${imported.userId}`);
}

function samlUserPropertyMapper(name: string, userProperty: string, attributeName: string) {
  return {
    name,
    protocol: "saml",
    protocolMapper: "saml-user-property-mapper",
    consentRequired: false,
    config: {
      "attribute.name": attributeName,
      "attribute.nameformat": "Basic",
      "friendly.name": attributeName,
      "user.attribute": userProperty,
    },
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

void main()
  .finally(async () => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
