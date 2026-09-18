import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const rootPackage = JSON.parse(
  readFileSync(resolve(here, "../../../package.json"), "utf8"),
);
const apiDockerfile = readFileSync(resolve(here, "../../../Dockerfile"), "utf8");

describe("root dependency install contract", () => {
  it("generates the API Prisma Client after npm install/ci", () => {
    expect(rootPackage.scripts?.postinstall).toBe("npm run api:prisma:generate");
  });

  it("copies the Prisma schema before dependency install in the API image", () => {
    const schemaCopy = apiDockerfile.indexOf(
      "COPY packages/resourceportal-api/prisma ./packages/resourceportal-api/prisma",
    );
    const dependencyInstall = apiDockerfile.indexOf(
      "RUN npm ci --workspace @resource-portal/api --include-workspace-root=false",
    );

    expect(schemaCopy).toBeGreaterThanOrEqual(0);
    expect(dependencyInstall).toBeGreaterThan(schemaCopy);
  });
});
