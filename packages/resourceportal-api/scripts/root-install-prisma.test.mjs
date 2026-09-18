import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prismaPostinstallPrerequisites } from "../../../scripts/postinstall-prisma.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rootPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const apiDockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
const webDockerfile = readFileSync(
  resolve(repoRoot, "packages/resourceportal-web/Dockerfile"),
  "utf8",
);
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("root dependency install contract", () => {
  it("uses the guarded Prisma postinstall helper", () => {
    expect(rootPackage.scripts?.postinstall).toBe(
      "node scripts/postinstall-prisma.mjs",
    );
  });

  it("runs Prisma generation only when the API schema and Prisma CLI are present", () => {
    const root = mkdtempSync(join(tmpdir(), "rp-postinstall-"));
    tempRoots.push(root);

    expect(prismaPostinstallPrerequisites(root)).toBe(false);

    const schemaDir = resolve(root, "packages/resourceportal-api/prisma");
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(resolve(schemaDir, "schema.prisma"), "");
    expect(prismaPostinstallPrerequisites(root)).toBe(false);

    const prismaDir = resolve(root, "node_modules/prisma");
    mkdirSync(prismaDir, { recursive: true });
    writeFileSync(resolve(prismaDir, "package.json"), "{}");
    expect(prismaPostinstallPrerequisites(root)).toBe(true);
  });

  it("makes the guarded helper available before workspace dependency installs", () => {
    const helperCopy = "COPY scripts/postinstall-prisma.mjs ./scripts/postinstall-prisma.mjs";
    const apiInstall =
      "RUN npm ci --workspace @resource-portal/api --include-workspace-root=false";
    const webInstall =
      "RUN npm ci --workspace @resource-portal/web --include-workspace-root=false";

    expect(apiDockerfile.indexOf(helperCopy)).toBeGreaterThanOrEqual(0);
    expect(apiDockerfile.indexOf(apiInstall)).toBeGreaterThan(
      apiDockerfile.indexOf(helperCopy),
    );
    expect(webDockerfile.indexOf(helperCopy)).toBeGreaterThanOrEqual(0);
    expect(webDockerfile.indexOf(webInstall)).toBeGreaterThan(
      webDockerfile.indexOf(helperCopy),
    );
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
