import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

type Organization = {
  id: string;
  name: string;
};

type Project = {
  id: string;
  name: string;
};

type App = {
  id: string;
  name: string;
  oidcConfig?: {
    clientId?: string;
  };
};

type User = {
  id: string;
  userName?: string;
  loginNames?: string[];
  preferredLoginName?: string;
  human?: {
    email?: {
      email?: string;
    };
  };
};

const envFilePaths = [".env", "../../.env"];
const bootstrapMode = process.env.ZITADEL_BOOTSTRAP_MODE ?? "development";
const productionBootstrap = bootstrapMode === "production";
const bootstrapOutputFile = process.env.ZITADEL_BOOTSTRAP_OUTPUT_FILE;

loadDotEnv();

const issuerUrl = (
  process.env.ZITADEL_ISSUER_URL ??
  process.env.OIDC_ISSUER_URL ??
  "http://localhost:8080"
).replace(/\/$/, "");
const patFile =
  process.env.ZITADEL_BOOTSTRAP_PAT_FILE ?? "var/zitadel/admin.pat";
const organizationName =
  process.env.ZITADEL_BOOTSTRAP_ORGANIZATION_NAME ?? "Resource Portal";
const projectName =
  process.env.ZITADEL_BOOTSTRAP_PROJECT_NAME ?? "Resource Portal";
const appName =
  process.env.ZITADEL_BOOTSTRAP_APP_NAME ?? "Resource Portal Web";
const redirectUris = listEnv(
  "ZITADEL_BOOTSTRAP_REDIRECT_URIS",
  `http://localhost:${process.env.PORT ?? "3000"}/api/auth/callback`,
);
const postLogoutRedirectUris = listEnv(
  "ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS",
  `http://localhost:${process.env.PORT ?? "3000"}/api/auth/logout/callback`,
);
const bootstrapUserUsername =
  process.env.ZITADEL_BOOTSTRAP_ADMIN_USERNAME ??
  process.env.ZITADEL_BOOTSTRAP_TEST_USER_USERNAME ??
  "resource-user";
const bootstrapUserEmail = (
  process.env.ZITADEL_BOOTSTRAP_ADMIN_EMAIL ??
  process.env.ZITADEL_BOOTSTRAP_TEST_USER_EMAIL ??
  "resource-user@example.local"
).toLowerCase();
const bootstrapUserPassword =
  process.env.ZITADEL_BOOTSTRAP_ADMIN_PASSWORD ??
  readOptionalFile(process.env.ZITADEL_BOOTSTRAP_ADMIN_PASSWORD_FILE ?? "")?.trim() ??
  process.env.ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD;

async function main() {
  await waitForZitadel();

  const pat = readPat();
  const organization = await getOrCreateOrganization(pat);
  const project = await getOrCreateProject(pat, organization.id);
  const app = await getOrCreateOidcApp(pat, organization.id, project.id);
  const bootstrapUser = await getOrCreateBootstrapUser(pat, organization.id);

  if (productionBootstrap) {
    if (!bootstrapOutputFile) {
      throw new Error("ZITADEL_BOOTSTRAP_OUTPUT_FILE is required in production bootstrap mode");
    }
    writeFileSync(
      bootstrapOutputFile,
      `${JSON.stringify({
        organizationId: organization.id,
        projectId: project.id,
        appId: app.appId,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        userId: bootstrapUser.id,
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(bootstrapOutputFile, 0o600);
    for (const [suffix, value] of [
      ["client-id", app.clientId],
      ["client-secret", app.clientSecret],
      ["user-id", bootstrapUser.id],
    ] as const) {
      const sidecar = `${bootstrapOutputFile}.${suffix}`;
      writeFileSync(sidecar, `${value}\n`, { mode: 0o600 });
      chmodSync(sidecar, 0o600);
    }
    console.log("ZITADEL production bootstrap completed");
    console.log(`Platform Admin user id: ${bootstrapUser.id}`);
  } else {
    updateDotEnv({
      ZITADEL_ORGANIZATION_ID: organization.id,
      ZITADEL_PROJECT_ID: project.id,
      OIDC_ISSUER_URL: issuerUrl,
      OIDC_CLIENT_ID: app.clientId,
      OIDC_CLIENT_SECRET: app.clientSecret,
      OIDC_AUDIENCE: app.clientId,
    });
    console.log("ZITADEL bootstrap completed");
    console.log(`Organization: ${organization.id} (${organization.name})`);
    console.log(`Project: ${project.id} (${project.name})`);
    console.log(`OIDC app: ${app.appId} (${app.name})`);
    console.log(`OIDC client id: ${app.clientId}`);
    console.log(`Test user: ${bootstrapUser.id} (${bootstrapUserEmail})`);
  }
}

async function waitForZitadel() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`${issuerUrl}/debug/healthz`);

      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the local container finishes its bootstrap.
    }

    await delay(1000);
  }

  throw new Error(`ZITADEL is not healthy at ${issuerUrl}`);
}

function readPat() {
  const pat = process.env.ZITADEL_BOOTSTRAP_PAT ?? readOptionalFile(patFile);

  if (!pat) {
    throw new Error(
      `Missing ZITADEL bootstrap PAT. Set ZITADEL_BOOTSTRAP_PAT or recreate local ZITADEL with ${patFile} generated from FirstInstance.PatPath.`,
    );
  }

  return pat.trim();
}

async function getOrCreateOrganization(pat: string): Promise<Organization> {
  const organizations = await zitadelApi<{
    result?: Array<{ id?: string; organizationId?: string; name?: string }>;
  }>(pat, "/v2/organizations/_search", {});
  const existing = organizations.result?.find(
    (organization) => organization.name === organizationName,
  );
  const existingId = existing?.id ?? existing?.organizationId;

  if (existingId) {
    return {
      id: existingId,
      name: existing?.name ?? organizationName,
    };
  }

  const created = await zitadelApi<{
    organizationId?: string;
    orgId?: string;
  }>(pat, "/v2/organizations", {
    name: organizationName,
  });
  const organizationId = created.organizationId ?? created.orgId;

  if (!organizationId) {
    throw new Error("ZITADEL organization creation did not return an id");
  }

  return {
    id: organizationId,
    name: organizationName,
  };
}

async function getOrCreateProject(pat: string, organizationId: string) {
  const projects = await zitadelApi<{ result?: Project[] }>(
    pat,
    "/management/v1/projects/_search",
    {},
    organizationId,
  );
  const existing = projects.result?.find((project) => project.name === projectName);

  if (existing) {
    return existing;
  }

  const created = await zitadelApi<{ id: string }>(
    pat,
    "/management/v1/projects",
    {
      name: projectName,
    },
    organizationId,
  );

  return {
    id: created.id,
    name: projectName,
  };
}

async function getOrCreateOidcApp(
  pat: string,
  organizationId: string,
  projectId: string,
) {
  const apps = await zitadelApi<{ result?: App[] }>(
    pat,
    `/management/v1/projects/${projectId}/apps/_search`,
    {},
    organizationId,
  );
  const existing = apps.result?.find((app) => app.name === appName);

  if (existing?.oidcConfig?.clientId) {
    return {
      appId: existing.id,
      clientId: existing.oidcConfig.clientId,
      clientSecret:
        process.env.OIDC_CLIENT_SECRET ??
        readOptionalFile(process.env.OIDC_CLIENT_SECRET_FILE ?? "")?.trim() ??
        "",
      name: existing.name,
    };
  }

  const created = await zitadelApi<{
    appId: string;
    clientId: string;
    clientSecret?: string;
  }>(
    pat,
    `/management/v1/projects/${projectId}/apps/oidc`,
    {
      name: appName,
      redirectUris,
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      postLogoutRedirectUris,
      version: "OIDC_VERSION_1_0",
      devMode: !productionBootstrap,
      accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      idTokenUserinfoAssertion: true,
    },
    organizationId,
  );

  return {
    appId: created.appId,
    clientId: created.clientId,
    clientSecret: created.clientSecret ?? "",
    name: appName,
  };
}

async function getOrCreateBootstrapUser(pat: string, organizationId: string) {
  const users = await zitadelApi<{ result?: User[] }>(
    pat,
    "/management/v1/users/_search",
    {},
    organizationId,
  );
  const existing = users.result?.find((user) => {
    const emails = [
      user.human?.email?.email,
      user.preferredLoginName,
      user.userName,
      ...(user.loginNames ?? []),
    ];

    return emails.some((value) => value?.toLowerCase() === bootstrapUserEmail);
  });

  if (existing) {
    return existing;
  }

  if (!bootstrapUserPassword) {
    throw new Error(
      productionBootstrap
        ? "ZITADEL_BOOTSTRAP_ADMIN_PASSWORD(_FILE) is required to create the first Platform Admin"
        : "ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD is required to create the local test user",
    );
  }

  const created = await zitadelApi<{ userId: string }>(
    pat,
    "/management/v1/users/human/_import",
    {
      userName: bootstrapUserUsername,
      profile: {
        firstName: productionBootstrap ? "Platform" : "Resource",
        lastName: productionBootstrap ? "Admin" : "User",
        displayName: productionBootstrap ? "Platform Admin" : "Resource User",
        preferredLanguage: "en",
      },
      email: {
        email: bootstrapUserEmail,
        isEmailVerified: true,
      },
      password: bootstrapUserPassword,
      passwordChangeRequired: false,
    },
    organizationId,
  );

  return {
    id: created.userId,
  };
}

async function zitadelApi<T>(
  pat: string,
  path: string,
  body: JsonObject,
  organizationId?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${pat}`,
    "content-type": "application/json",
  };

  if (organizationId && path.startsWith("/management/v1/")) {
    headers["x-zitadel-orgid"] = organizationId;
  }

  const response = await fetch(`${issuerUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    throw new Error(
      `ZITADEL API ${path} failed with ${response.status}: ${JSON.stringify(
        payload,
      )}`,
    );
  }

  return payload as T;
}

function updateDotEnv(values: Record<string, string>) {
  const path = envFilePaths.find((candidate) => existsSync(candidate)) ?? ".env";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const seen = new Set<string>();
  const lines = existing.split("\n").map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);

    if (!match || values[match[1]] === undefined) {
      return line;
    }

    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(path, `${lines.filter((line) => line.length > 0).join("\n")}\n`);
}

function loadDotEnv() {
  for (const path of envFilePaths) {
    if (!existsSync(path)) {
      continue;
    }

    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 1) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex);
      const value = trimmed.slice(separatorIndex + 1);

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function listEnv(key: string, fallback: string) {
  return (process.env[key] ?? fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readOptionalFile(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }

  return readFileSync(path, "utf8");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
