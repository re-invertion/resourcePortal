import { existsSync, readFileSync, writeFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

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

loadDotEnv();

const issuerUrl = (
  process.env.ZITADEL_ISSUER_URL ??
  process.env.OIDC_ISSUER_URL ??
  "http://localhost:8080"
).replace(/\/$/, "");
const patFile =
  process.env.ZITADEL_BOOTSTRAP_PAT_FILE ?? "var/zitadel/admin.pat";
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
const testUserUsername =
  process.env.ZITADEL_BOOTSTRAP_TEST_USER_USERNAME ?? "resource-user";
const testUserEmail =
  process.env.ZITADEL_BOOTSTRAP_TEST_USER_EMAIL ??
  "resource-user@example.local";
const testUserPassword = process.env.ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD;

async function main() {
  await waitForZitadel();

  const pat = readPat();
  const project = await getOrCreateProject(pat);
  const app = await getOrCreateOidcApp(pat, project.id);
  const testUser = await getOrCreateTestUser(pat);

  updateDotEnv({
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: app.clientId,
    OIDC_CLIENT_SECRET: app.clientSecret,
    OIDC_AUDIENCE: app.clientId,
  });

  console.log("ZITADEL bootstrap completed");
  console.log(`Project: ${project.id} (${project.name})`);
  console.log(`OIDC app: ${app.appId} (${app.name})`);
  console.log(`OIDC client id: ${app.clientId}`);
  console.log(`OIDC client secret: ${maskSecret(app.clientSecret)}`);
  console.log(`Test user: ${testUser.id} (${testUserEmail})`);
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

async function getOrCreateProject(pat: string) {
  const projects = await zitadelApi<{ result?: Project[] }>(
    pat,
    "/management/v1/projects/_search",
    {},
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
  );

  return {
    id: created.id,
    name: projectName,
  };
}

async function getOrCreateOidcApp(pat: string, projectId: string) {
  const apps = await zitadelApi<{ result?: App[] }>(
    pat,
    `/management/v1/projects/${projectId}/apps/_search`,
    {},
  );
  const existing = apps.result?.find((app) => app.name === appName);

  if (existing?.oidcConfig?.clientId) {
    return {
      appId: existing.id,
      clientId: existing.oidcConfig.clientId,
      clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
      name: existing.name,
    };
  }

  const created = await zitadelApi<{
    appId: string;
    clientId: string;
    clientSecret?: string;
  }>(pat, `/management/v1/projects/${projectId}/apps/oidc`, {
    name: appName,
    redirectUris,
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_WEB",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
    postLogoutRedirectUris,
    version: "OIDC_VERSION_1_0",
    devMode: true,
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    idTokenUserinfoAssertion: true,
  });

  return {
    appId: created.appId,
    clientId: created.clientId,
    clientSecret: created.clientSecret ?? "",
    name: appName,
  };
}

async function getOrCreateTestUser(pat: string) {
  const users = await zitadelApi<{ result?: User[] }>(
    pat,
    "/management/v1/users/_search",
    {},
  );
  const existing = users.result?.find((user) => {
    const emails = [
      user.human?.email?.email,
      user.preferredLoginName,
      user.userName,
      ...(user.loginNames ?? []),
    ];

    return emails.some((value) => value?.toLowerCase() === testUserEmail);
  });

  if (existing) {
    return existing;
  }

  if (!testUserPassword) {
    throw new Error(
      "ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD is required to create the local test user",
    );
  }

  const created = await zitadelApi<{ userId: string }>(
    pat,
    "/management/v1/users/human/_import",
    {
      userName: testUserUsername,
      profile: {
        firstName: "Resource",
        lastName: "User",
        displayName: "Resource User",
        preferredLanguage: "en",
      },
      email: {
        email: testUserEmail,
        isEmailVerified: true,
      },
      password: testUserPassword,
      passwordChangeRequired: false,
    },
  );

  return {
    id: created.userId,
  };
}

async function zitadelApi<T>(
  pat: string,
  path: string,
  body: JsonObject,
): Promise<T> {
  const response = await fetch(`${issuerUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
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
  const path = ".env";
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
  if (!existsSync(".env")) {
    return;
  }

  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
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

function maskSecret(secret: string) {
  if (!secret) {
    return "(existing app secret not available)";
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
