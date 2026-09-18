import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const script = readFileSync(resolve("scripts/run-federation-e2e.sh"), "utf8");
const databaseBody = script.match(/^database\(\) \{([\s\S]*?)^\}/m)?.[1] ?? "";

assert(databaseBody, "database() function is missing");
assert(
  databaseBody.includes("generate_prisma_client"),
  "database() must generate Prisma Client before migrate/seed on a fresh checkout",
);

const generateAt = databaseBody.indexOf("generate_prisma_client");
const migrateAt = databaseBody.indexOf("migrate_database");
const seedAt = databaseBody.indexOf("seed_database");
assert(generateAt >= 0 && migrateAt >= 0 && seedAt >= 0, "database() sequence is incomplete");
assert(generateAt < migrateAt, "Prisma Client generation must run before migrations");
assert(migrateAt < seedAt, "migrations must run before seed");

console.log("PASS: federation database phase generates Prisma Client before migrate/seed");

const browserBody = script.match(/^browser_login\(\) \{([\s\S]*?)^\}/m)?.[1] ?? "";
assert(browserBody, "browser_login() function is missing");
assert(
  browserBody.includes("node node_modules/playwright/cli.js install chromium"),
  "browser_login() must ensure the Playwright Chromium binary exists on a fresh E2E host",
);

assert(
  browserBody.includes("node scripts/run-v019-final-ui-e2e.mjs"),
  "browser_login() must run the v0.1.9 final-UI browser smoke",
);
assert(
  !browserBody.includes("node scripts/run-stage20-web-e2e.mjs"),
  "browser_login() must not use the legacy Stage 20 Web Console browser gate for v0.1.9",
);
