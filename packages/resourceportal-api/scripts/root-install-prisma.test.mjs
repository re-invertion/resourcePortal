import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const rootPackage = JSON.parse(
  readFileSync(resolve(here, "../../../package.json"), "utf8"),
);

describe("root dependency install contract", () => {
  it("generates the API Prisma Client after npm install/ci", () => {
    expect(rootPackage.scripts?.postinstall).toBe("npm run api:prisma:generate");
  });
});
