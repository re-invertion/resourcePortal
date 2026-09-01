#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ResourcePortalApiError, ResourcePortalClient } from "@resource-portal/sdk";

type CliConfig = {
  apiUrl?: string;
  devUserId?: string;
  token?: string;
};

type HealthOptions = {
  apiUrl: string;
  correlationId?: string;
  devUserId?: string;
  output: "json" | "table";
  requestId?: string;
  token?: string;
};

const argv = process.argv.slice(2);
const positional = argv.filter((value, index) => {
  if (value.startsWith("-")) return false;
  const previous = argv[index - 1];
  return ![
    "--api-url",
    "--token",
    "--dev-user-id",
    "--correlation-id",
    "--request-id",
    "--output",
    "-o",
  ].includes(previous);
});
const group = positional[0];
const command = positional[1];
const help = argv.includes("--help") || argv.includes("-h");

if (help && !group) {
  printHealthHelp();
  require("./full-cli.js");
} else if (group !== "health") {
  require("./full-cli.js");
} else if (help || !command) {
  printHealthHelp();
} else {
  runHealth(command, parseOptions(argv)).catch(handleError);
}

async function runHealth(commandName: string, options: HealthOptions) {
  const client = new ResourcePortalClient({
    apiUrl: options.apiUrl,
    correlationId: options.correlationId,
    devUserId: options.devUserId,
    requestId: options.requestId,
    token: options.token,
  });

  let result: unknown;
  switch (commandName) {
    case "show":
      result = await client.health.get();
      break;
    case "live":
      result = await client.health.live();
      break;
    case "ready":
      result = await client.health.ready();
      break;
    default:
      throw new Error(`Unknown health command: ${commandName}`);
  }

  printResult(result, options.output);
}

function parseOptions(values: string[]): HealthOptions {
  const config = readConfig();
  const options: HealthOptions = {
    apiUrl:
      process.env.RESOURCE_PORTAL_API_URL ??
      config.apiUrl ??
      "http://localhost:3000/api",
    correlationId: process.env.RESOURCE_PORTAL_CORRELATION_ID,
    devUserId: process.env.RESOURCE_PORTAL_DEV_USER_ID ?? config.devUserId,
    output: "table",
    requestId: process.env.RESOURCE_PORTAL_REQUEST_ID,
    token: process.env.RESOURCE_PORTAL_TOKEN ?? config.token,
  };

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw === "--api-url") {
      options.apiUrl = requiredValue(values, index, raw);
      index += 1;
    } else if (raw === "--token") {
      options.token = requiredValue(values, index, raw);
      index += 1;
    } else if (raw === "--dev-user-id") {
      options.devUserId = requiredValue(values, index, raw);
      index += 1;
    } else if (raw === "--correlation-id") {
      options.correlationId = requiredValue(values, index, raw);
      index += 1;
    } else if (raw === "--request-id") {
      options.requestId = requiredValue(values, index, raw);
      index += 1;
    } else if (raw === "--output" || raw === "-o") {
      const output = requiredValue(values, index, raw);
      if (output !== "json" && output !== "table") {
        throw new Error("--output must be table or json");
      }
      options.output = output;
      index += 1;
    }
  }

  return options;
}

function printHealthHelp() {
  console.log("Resource Portal health commands");
  console.log("");
  console.log("Commands:");
  console.log("  health show   GET /health");
  console.log("  health live   GET /health/live");
  console.log("  health ready  GET /health/ready");
  console.log("");
}

function printResult(result: unknown, output: HealthOptions["output"]) {
  if (output === "json" || typeof result !== "object" || result === null) {
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 2),
    );
    return;
  }

  const record = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    console.log(`${key}\t${formatValue(value)}`);
  }
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readConfig(): CliConfig {
  const path = join(homedir(), ".resourceportal", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function requiredValue(values: string[], index: number, option: string) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function handleError(error: unknown) {
  if (error instanceof ResourcePortalApiError) {
    console.error(
      JSON.stringify(
        {
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: error.requestId,
          correlationId: error.correlationId,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
