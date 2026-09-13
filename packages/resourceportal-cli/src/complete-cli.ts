#!/usr/bin/env node
import { readConfig, resolveAuth } from "./auth.js";
import { ResourcePortalApiError, ResourcePortalClient } from "@resource-portal/sdk";

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
    "--name",
    "--size-bytes",
    "--description",
  ].includes(previous);
});
const group = positional[0];
const command = positional[1];
const help = argv.includes("--help") || argv.includes("-h");
const volumeCreateWait =
  group === "volume" && command === "create" && argv.includes("--wait");

if (help && !group) {
  printHealthHelp();
  require("./full-cli.js");
} else if (volumeCreateWait) {
  runVolumeCreateWait(positional[2], argv, parseOptions(argv)).catch(handleError);
} else if (group !== "health") {
  require("./full-cli.js");
} else if (help || !command) {
  printHealthHelp();
} else {
  runHealth(command, parseOptions(argv)).catch(handleError);
}

async function authenticatedClient(options: HealthOptions) {
  let auth: { token?: string; devUserId?: string } = options.token
    ? { token: options.token }
    : options.devUserId
      ? { devUserId: options.devUserId }
      : {};
  if (!options.token && !options.devUserId) {
    auth = await resolveAuth(options.apiUrl);
  }

  return new ResourcePortalClient({
    apiUrl: options.apiUrl,
    correlationId: options.correlationId,
    devUserId: auth.devUserId,
    requestId: options.requestId,
    token: auth.token,
  });
}

async function runHealth(commandName: string, options: HealthOptions) {
  let client: ResourcePortalClient;
  try {
    client = await authenticatedClient(options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Authentication expired. Run rp login."
    ) {
      client = new ResourcePortalClient({
        apiUrl: options.apiUrl,
        correlationId: options.correlationId,
        requestId: options.requestId,
      });
    } else {
      throw error;
    }
  }

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

async function runVolumeCreateWait(
  tenantId: string | undefined,
  values: string[],
  options: HealthOptions,
) {
  if (!tenantId) {
    throw new Error("Missing required argument: tenantId");
  }

  const name = optionValue(values, "--name");
  const sizeBytesRaw = optionValue(values, "--size-bytes");
  const sizeBytes = Number(sizeBytesRaw);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("--size-bytes must be a non-negative safe integer");
  }
  const description = optionalOptionValue(values, "--description");
  const client = await authenticatedClient(options);
  let operation: unknown = await client.volumes.create(tenantId, {
    name,
    sizeBytes,
    ...(description === undefined ? {} : { description }),
  });

  if (!isRecord(operation) || typeof operation.id !== "string") {
    throw new Error("Volume create did not return an operation id");
  }
  const operationId = operation.id;

  while (true) {
    if (!isRecord(operation) || typeof operation.status !== "string") {
      throw new Error(`Operation ${operationId} returned an invalid status`);
    }

    switch (operation.status) {
      case "Succeeded":
        printResult(operation, options.output);
        return;
      case "Failed":
      case "RollbackFailed":
      case "RolledBack": {
        const errorCode =
          typeof operation.errorCode === "string"
            ? operation.errorCode
            : operation.status;
        const errorMessage =
          typeof operation.errorMessage === "string"
            ? operation.errorMessage
            : "operation did not succeed";
        throw new Error(
          `Operation ${operationId} ${operation.status}: ${errorCode}: ${errorMessage}`,
        );
      }
      case "Pending":
      case "Running":
      case "RollingBack":
        await new Promise((resolve) => setTimeout(resolve, 100));
        operation = await client.operations.get(tenantId, operationId);
        break;
      default:
        throw new Error(
          `Operation ${operationId} returned unexpected status: ${operation.status}`,
        );
    }
  }
}

function parseOptions(values: string[]): HealthOptions {
  const config = readConfig();
  const options: HealthOptions = {
    apiUrl:
      process.env.RESOURCE_PORTAL_API_URL ??
      config.apiUrl ??
      "http://localhost:3000/api",
    correlationId: process.env.RESOURCE_PORTAL_CORRELATION_ID,
    output: "table",
    requestId: process.env.RESOURCE_PORTAL_REQUEST_ID,
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
  console.log("  volume create <tenantId> --name NAME --size-bytes N --wait");
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

function requiredValue(values: string[], index: number, option: string) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function optionValue(values: string[], option: string) {
  const index = values.indexOf(option);
  if (index === -1) {
    throw new Error(`Missing required flag: ${option}`);
  }
  return requiredValue(values, index, option);
}

function optionalOptionValue(values: string[], option: string) {
  const index = values.indexOf(option);
  return index === -1 ? undefined : requiredValue(values, index, option);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
