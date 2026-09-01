#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ResourcePortalApiError,
  ResourcePortalClient,
  ResourcePortalQuery,
} from "@resource-portal/sdk";

type OutputFormat = "json" | "table";
type FlagValue = string | number | boolean | FlagValue[];
type Flags = Record<string, FlagValue>;
type CliConfig = {
  apiUrl?: string;
  devUserId?: string;
  token?: string;
};

type ParsedArgs = {
  args: string[];
  command?: string;
  flags: Flags;
  group?: string;
  help: boolean;
  options: {
    apiUrl: string;
    correlationId?: string;
    devUserId?: string;
    output: OutputFormat;
    requestId?: string;
    token?: string;
  };
};

const COMPATIBILITY_GROUPS = new Set([
  "platform-billing",
  "swarm",
  "remote-location",
  "storage-backend",
  "operation",
  "platform-maintenance",
  "oauth-application",
  "platform-oauth-application",
  "service-identity",
  "platform-service-identity",
  "platform-identity-provider",
  "audit",
  "metrics",
]);

const DECIMAL_STRING_FIELDS = new Set([
  "cpuCreditsPerVcpuHour",
  "memoryCreditsPerGbHour",
  "storageCreditsPerGbHour",
  "gpuCreditsPerGpuHour",
  "valueCredits",
  "amountCredits",
]);

const DTO_ARRAY_FIELDS = new Set([
  "roleIds",
  "redirectUris",
  "postLogoutRedirectUris",
  "scopes",
]);

const parsed = parseArgs(process.argv.slice(2));

if (parsed.options.correlationId) {
  process.env.RESOURCE_PORTAL_CORRELATION_ID = parsed.options.correlationId;
}
if (parsed.options.requestId) {
  process.env.RESOURCE_PORTAL_REQUEST_ID = parsed.options.requestId;
}

if (parsed.help && !parsed.group) {
  printCompatibilityHelp();
  require("./legacy.js");
} else if (!parsed.group || !COMPATIBILITY_GROUPS.has(parsed.group)) {
  require("./legacy.js");
} else {
  runCompatibilityCommand(parsed).catch(handleError);
}

async function runCompatibilityCommand(parsedArgs: ParsedArgs) {
  if (parsedArgs.help || !parsedArgs.command) {
    printCompatibilityHelp(parsedArgs.group);
    return;
  }

  const client = new ResourcePortalClient({
    apiUrl: parsedArgs.options.apiUrl,
    correlationId: parsedArgs.options.correlationId,
    devUserId: parsedArgs.options.devUserId,
    requestId: parsedArgs.options.requestId,
    token: parsedArgs.options.token,
  });
  const key = `${parsedArgs.group} ${parsedArgs.command}`;
  let result: unknown;

  switch (key) {
    case "platform-billing price-list-list":
      result = await client.platformBilling.listPriceLists();
      break;
    case "platform-billing price-list-show":
      result = await client.platformBilling.getPriceList(
        arg(parsedArgs, 0, "priceListId"),
      );
      break;
    case "platform-billing price-list-create":
      result = await client.platformBilling.createPriceList(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-billing voucher-list":
      result = await client.platformBilling.listVouchers();
      break;
    case "platform-billing voucher-show":
      result = await client.platformBilling.getVoucher(
        arg(parsedArgs, 0, "voucherId"),
      );
      break;
    case "platform-billing voucher-create":
      result = await client.platformBilling.createVoucher(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-billing voucher-disable":
      result = await client.platformBilling.disableVoucher(
        arg(parsedArgs, 0, "voucherId"),
      );
      break;
    case "platform-billing payment":
      result = await client.platformBilling.payment(mutationBody(parsedArgs.flags));
      break;
    case "platform-billing refund":
      result = await client.platformBilling.refund(mutationBody(parsedArgs.flags));
      break;
    case "platform-billing correction":
      result = await client.platformBilling.correction(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "swarm show":
      result = await client.platformInfrastructure.getSwarmCluster();
      break;
    case "swarm reconcile":
      result = await client.platformInfrastructure.reconcileSwarmCluster();
      break;
    case "remote-location list":
      result = await client.platformInfrastructure.listRemoteLocations();
      break;
    case "remote-location show":
      result = await client.platformInfrastructure.getRemoteLocation(
        arg(parsedArgs, 0, "remoteLocationId"),
      );
      break;
    case "remote-location maintenance":
      result = await client.platformInfrastructure.setRemoteLocationMaintenance(
        arg(parsedArgs, 0, "remoteLocationId"),
        booleanFlag(parsedArgs.flags, "enabled"),
      );
      break;
    case "storage-backend list":
      result = await client.storageBackends.list();
      break;
    case "storage-backend show":
      result = await client.storageBackends.get(
        arg(parsedArgs, 0, "storageBackendId"),
      );
      break;
    case "storage-backend validate":
      result = await client.storageBackends.validate(
        arg(parsedArgs, 0, "storageBackendId"),
      );
      break;
    case "storage-backend maintenance":
      result = await client.storageBackends.setMaintenance(
        arg(parsedArgs, 0, "storageBackendId"),
        booleanFlag(parsedArgs.flags, "enabled"),
      );
      break;
    case "operation list":
      result = await client.operations.list(arg(parsedArgs, 0, "tenantId"));
      break;
    case "operation show":
      result = await client.operations.get(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "operationId"),
      );
      break;
    case "operation events":
      result = await client.operations.events(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "operationId"),
      );
      break;
    case "operation retry":
      result = await client.operations.retry(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "operationId"),
      );
      break;
    case "platform-maintenance show":
      result = await client.platformMaintenance.get();
      break;
    case "platform-maintenance set":
      result = await client.platformMaintenance.set(mutationBody(parsedArgs.flags));
      break;
    case "oauth-application list":
      result = await client.oauthApplications.list(arg(parsedArgs, 0, "tenantId"));
      break;
    case "oauth-application show":
      result = await client.oauthApplications.get(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "applicationId"),
      );
      break;
    case "oauth-application create":
      result = await client.oauthApplications.create(
        arg(parsedArgs, 0, "tenantId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "oauth-application update":
      result = await client.oauthApplications.update(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "applicationId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "oauth-application rotate-credentials":
      result = await client.oauthApplications.rotateCredentials(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "applicationId"),
      );
      break;
    case "oauth-application delete":
      result = await client.oauthApplications.delete(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "applicationId"),
      );
      break;
    case "platform-oauth-application list":
      result = await client.platformOauthApplications.list();
      break;
    case "platform-oauth-application show":
      result = await client.platformOauthApplications.get(
        arg(parsedArgs, 0, "applicationId"),
      );
      break;
    case "platform-oauth-application create":
      result = await client.platformOauthApplications.create(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-oauth-application update":
      result = await client.platformOauthApplications.update(
        arg(parsedArgs, 0, "applicationId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-oauth-application rotate-credentials":
      result = await client.platformOauthApplications.rotateCredentials(
        arg(parsedArgs, 0, "applicationId"),
      );
      break;
    case "platform-oauth-application delete":
      result = await client.platformOauthApplications.delete(
        arg(parsedArgs, 0, "applicationId"),
      );
      break;
    case "service-identity list":
      result = await client.serviceIdentities.list(arg(parsedArgs, 0, "tenantId"));
      break;
    case "service-identity show":
      result = await client.serviceIdentities.get(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "serviceIdentityId"),
      );
      break;
    case "service-identity create":
      result = await client.serviceIdentities.create(
        arg(parsedArgs, 0, "tenantId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "service-identity update":
      result = await client.serviceIdentities.update(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "serviceIdentityId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "service-identity rotate-credentials":
      result = await client.serviceIdentities.rotateCredentials(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "serviceIdentityId"),
      );
      break;
    case "service-identity delete":
      result = await client.serviceIdentities.delete(
        arg(parsedArgs, 0, "tenantId"),
        arg(parsedArgs, 1, "serviceIdentityId"),
      );
      break;
    case "platform-service-identity list":
      result = await client.platformServiceIdentities.list();
      break;
    case "platform-service-identity show":
      result = await client.platformServiceIdentities.get(
        arg(parsedArgs, 0, "serviceIdentityId"),
      );
      break;
    case "platform-service-identity create":
      result = await client.platformServiceIdentities.create(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-service-identity update":
      result = await client.platformServiceIdentities.update(
        arg(parsedArgs, 0, "serviceIdentityId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-service-identity rotate-credentials":
      result = await client.platformServiceIdentities.rotateCredentials(
        arg(parsedArgs, 0, "serviceIdentityId"),
      );
      break;
    case "platform-service-identity delete":
      result = await client.platformServiceIdentities.delete(
        arg(parsedArgs, 0, "serviceIdentityId"),
      );
      break;
    case "platform-identity-provider list":
      result = await client.platformIdentityProviders.list();
      break;
    case "platform-identity-provider show":
      result = await client.platformIdentityProviders.get(
        arg(parsedArgs, 0, "identityProviderId"),
      );
      break;
    case "platform-identity-provider create":
      result = await client.platformIdentityProviders.create(
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-identity-provider update":
      result = await client.platformIdentityProviders.update(
        arg(parsedArgs, 0, "identityProviderId"),
        mutationBody(parsedArgs.flags),
      );
      break;
    case "platform-identity-provider delete":
      result = await client.platformIdentityProviders.delete(
        arg(parsedArgs, 0, "identityProviderId"),
      );
      break;
    case "audit list":
      result = await client.auditLog.list(
        arg(parsedArgs, 0, "tenantId"),
        queryFromFlags(parsedArgs.flags),
      );
      break;
    case "audit export":
      result = await client.auditLog.export(
        arg(parsedArgs, 0, "tenantId"),
        queryFromFlags(parsedArgs.flags),
      );
      break;
    case "metrics show":
      result = await client.metrics.get();
      break;
    default:
      throw new Error(`Unknown compatibility command: ${key}`);
  }

  printResult(result, parsedArgs.options.output);
}

function parseArgs(argv: string[]): ParsedArgs {
  const config = readConfig();
  const options: ParsedArgs["options"] = {
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
  const positional: string[] = [];
  const flags: Flags = {};
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") {
      help = true;
      continue;
    }
    if (raw === "--api-url") {
      options.apiUrl = requiredOptionValue(argv, index, raw);
      index += 1;
      continue;
    }
    if (raw === "--token") {
      options.token = requiredOptionValue(argv, index, raw);
      index += 1;
      continue;
    }
    if (raw === "--dev-user-id") {
      options.devUserId = requiredOptionValue(argv, index, raw);
      index += 1;
      continue;
    }
    if (raw === "--correlation-id") {
      options.correlationId = requiredOptionValue(argv, index, raw);
      index += 1;
      continue;
    }
    if (raw === "--request-id") {
      options.requestId = requiredOptionValue(argv, index, raw);
      index += 1;
      continue;
    }
    if (raw === "--output" || raw === "-o") {
      const value = requiredOptionValue(argv, index, raw);
      if (value !== "json" && value !== "table") {
        throw new Error("--output must be table or json");
      }
      options.output = value;
      index += 1;
      continue;
    }
    if (raw.startsWith("--")) {
      const key = camelCase(raw.slice(2));
      const next = argv[index + 1];
      const value = !next || next.startsWith("--") ? true : coerceFlagValue(key, next);
      if (value !== true || next === "true") index += 1;
      appendFlag(flags, key, value);
      continue;
    }
    positional.push(raw);
  }

  return {
    args: positional.slice(2),
    command: positional[1],
    flags,
    group: positional[0],
    help,
    options,
  };
}

function mutationBody(flags: Flags): Record<string, unknown> {
  const bodyJson = scalarFlag(flags, "bodyJson");
  if (bodyJson !== undefined) {
    if (typeof bodyJson !== "string") {
      throw new Error("--body-json must be a JSON string");
    }
    const parsedBody: unknown = JSON.parse(bodyJson);
    if (!isRecord(parsedBody)) {
      throw new Error("--body-json must contain a JSON object");
    }
    return parsedBody;
  }

  return Object.fromEntries(
    Object.entries(flags)
      .filter(([key]) => key !== "bodyJson")
      .map(([key, value]) => [key, normalizeMutationValue(key, value)]),
  );
}

function queryFromFlags(flags: Flags): ResourcePortalQuery {
  return Object.fromEntries(
    Object.entries(flags).map(([key, value]) => [
      key,
      normalizeQueryValue(value),
    ]),
  );
}

function normalizeMutationValue(key: string, value: FlagValue): unknown {
  const normalized = normalizeFlagValue(value);
  if (DTO_ARRAY_FIELDS.has(key) && !Array.isArray(normalized)) {
    return [normalized];
  }
  return normalized;
}

function normalizeFlagValue(value: FlagValue): unknown {
  return Array.isArray(value) ? value.map(normalizeFlagValue) : value;
}

function normalizeQueryValue(
  value: FlagValue,
): string | number | boolean | Array<string | number | boolean> {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (Array.isArray(item)) throw new Error("Nested query flags are unsupported");
      return item;
    });
  }
  return value;
}

function booleanFlag(flags: Flags, key: string) {
  const value = scalarFlag(flags, key);
  if (typeof value !== "boolean") {
    throw new Error(`--${kebabCase(key)} must be true or false`);
  }
  return value;
}

function scalarFlag(flags: Flags, key: string) {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return value;
}

function appendFlag(flags: Flags, key: string, value: string | number | boolean) {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags[key] = [existing, value];
  }
}

function coerceFlagValue(key: string, value: string): string | number | boolean {
  if (DECIMAL_STRING_FIELDS.has(key) || DTO_ARRAY_FIELDS.has(key)) return value;
  return coerce(value);
}

function coerce(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function printCompatibilityHelp(group?: string) {
  const commands = [
    "platform-billing price-list-list",
    "platform-billing price-list-show <priceListId>",
    "platform-billing price-list-create --effective-from DATE --cpu-credits-per-vcpu-hour N --memory-credits-per-gb-hour N --storage-credits-per-gb-hour N --gpu-credits-per-gpu-hour N",
    "platform-billing voucher-list",
    "platform-billing voucher-show <voucherId>",
    "platform-billing voucher-create --value-credits N [--expires-at DATE]",
    "platform-billing voucher-disable <voucherId>",
    "platform-billing payment --tenant-id ID --amount-credits N [flags]",
    "platform-billing refund --tenant-id ID --amount-credits N --reason TEXT [flags]",
    "platform-billing correction --tenant-id ID --amount-credits N --reason TEXT [flags]",
    "swarm show",
    "swarm reconcile",
    "remote-location list",
    "remote-location show <remoteLocationId>",
    "remote-location maintenance <remoteLocationId> --enabled true|false",
    "storage-backend list",
    "storage-backend show <storageBackendId>",
    "storage-backend validate <storageBackendId>",
    "storage-backend maintenance <storageBackendId> --enabled true|false",
    "operation list <tenantId>",
    "operation show <tenantId> <operationId>",
    "operation events <tenantId> <operationId>",
    "operation retry <tenantId> <operationId>",
    "platform-maintenance show",
    "platform-maintenance set --enabled true|false [--reason TEXT]",
    "oauth-application list <tenantId>",
    "oauth-application show <tenantId> <applicationId>",
    "oauth-application create <tenantId> --name NAME --type TYPE [flags]",
    "oauth-application update <tenantId> <applicationId> [flags]",
    "oauth-application rotate-credentials <tenantId> <applicationId>",
    "oauth-application delete <tenantId> <applicationId>",
    "platform-oauth-application list",
    "platform-oauth-application show <applicationId>",
    "platform-oauth-application create --name NAME --type TYPE [flags]",
    "platform-oauth-application update <applicationId> [flags]",
    "platform-oauth-application rotate-credentials <applicationId>",
    "platform-oauth-application delete <applicationId>",
    "service-identity list <tenantId>",
    "service-identity show <tenantId> <serviceIdentityId>",
    "service-identity create <tenantId> --name NAME --role-ids ID [--role-ids ID] [flags]",
    "service-identity update <tenantId> <serviceIdentityId> [flags]",
    "service-identity rotate-credentials <tenantId> <serviceIdentityId>",
    "service-identity delete <tenantId> <serviceIdentityId>",
    "platform-service-identity list",
    "platform-service-identity show <serviceIdentityId>",
    "platform-service-identity create --name NAME [flags]",
    "platform-service-identity update <serviceIdentityId> [flags]",
    "platform-service-identity rotate-credentials <serviceIdentityId>",
    "platform-service-identity delete <serviceIdentityId>",
    "platform-identity-provider list",
    "platform-identity-provider show <identityProviderId>",
    "platform-identity-provider create --name NAME --protocol OIDC|SAML [flags]",
    "platform-identity-provider update <identityProviderId> [flags]",
    "platform-identity-provider delete <identityProviderId>",
    "audit list <tenantId> [filter flags]",
    "audit export <tenantId> [--format json|csv] [filter flags]",
    "metrics show",
  ].filter((line) => !group || line.startsWith(`${group} `));

  console.log("Resource Portal CLI compatibility commands");
  console.log("");
  console.log("Global options:");
  console.log("  --correlation-id ID  Send x-correlation-id.");
  console.log("  --request-id ID      Send x-request-id.");
  console.log("  --api-url URL --token TOKEN --dev-user-id USER_ID -o table|json");
  console.log("");
  console.log("Commands:");
  for (const command of commands) console.log(`  ${command}`);
  console.log("");
  console.log("Mutation commands accept DTO fields as kebab-case flags and --body-json JSON.");
}

function printResult(result: unknown, output: OutputFormat) {
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (Array.isArray(result)) {
    printTable(result);
    return;
  }
  if (isRecord(result)) {
    printTable([result]);
    return;
  }
  console.log(result);
}

function printTable(rows: unknown[]) {
  const records = rows.filter(isRecord);
  if (records.length === 0) return;
  const columns = Array.from(
    new Set(records.flatMap((row) => Object.keys(row).slice(0, 8))),
  );
  const widths = columns.map((column) =>
    Math.max(column.length, ...records.map((row) => formatCell(row[column]).length)),
  );
  console.log(columns.map((column, index) => column.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of records) {
    console.log(
      columns
        .map((column, index) => formatCell(row[column]).padEnd(widths[index]))
        .join("  "),
    );
  }
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function readConfig(): CliConfig {
  const path = join(homedir(), ".resourceportal", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function requiredOptionValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function arg(parsedArgs: ParsedArgs, index: number, name: string) {
  const value = parsedArgs.args[index];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function camelCase(value: string) {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
