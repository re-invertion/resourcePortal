#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type OutputFormat = "json" | "table";

type CliConfig = {
  apiUrl?: string;
  token?: string;
};

type GlobalOptions = {
  apiUrl: string;
  token?: string;
  output: OutputFormat;
};

type Command = {
  group: string;
  name: string;
  summary: string;
  run: (args: string[], options: GlobalOptions) => Promise<unknown>;
};

const commands: Command[] = [
  {
    group: "account",
    name: "show",
    summary: "Show current authenticated account.",
    run: (_args, options) => request(options, "/auth/me"),
  },
  {
    group: "tenant",
    name: "list",
    summary: "List tenants available to the current account.",
    run: (_args, options) => request(options, "/tenants"),
  },
  {
    group: "tenant",
    name: "show",
    summary: "Show one tenant by id.",
    run: (args, options) => request(options, `/tenants/${requiredArg(args, "tenantId")}`),
  },
  {
    group: "app-group",
    name: "list",
    summary: "List app groups in a tenant.",
    run: (args, options) =>
      request(options, `/tenants/${requiredArg(args, "tenantId")}/app-groups`),
  },
  {
    group: "app-group",
    name: "show",
    summary: "Show one app group by id.",
    run: (args, options) => {
      const tenantId = requiredArg(args, "tenantId");
      const appGroupId = requiredArg(args, "appGroupId", 1);

      return request(options, `/tenants/${tenantId}/app-groups/${appGroupId}`);
    },
  },
  {
    group: "deployment",
    name: "list",
    summary: "List deployments for an app group.",
    run: (args, options) => {
      const tenantId = requiredArg(args, "tenantId");
      const appGroupId = requiredArg(args, "appGroupId", 1);

      return request(
        options,
        `/tenants/${tenantId}/app-groups/${appGroupId}/deployments`,
      );
    },
  },
  {
    group: "deployment",
    name: "show",
    summary: "Show one deployment by id.",
    run: (args, options) => {
      const tenantId = requiredArg(args, "tenantId");
      const appGroupId = requiredArg(args, "appGroupId", 1);
      const deploymentId = requiredArg(args, "deploymentId", 2);

      return request(
        options,
        `/tenants/${tenantId}/app-groups/${appGroupId}/deployments/${deploymentId}`,
      );
    },
  },
  {
    group: "volume",
    name: "list",
    summary: "List volumes in a tenant.",
    run: (args, options) =>
      request(options, `/tenants/${requiredArg(args, "tenantId")}/volumes`),
  },
  {
    group: "domain",
    name: "list",
    summary: "List domains in a tenant.",
    run: (args, options) =>
      request(options, `/tenants/${requiredArg(args, "tenantId")}/domains`),
  },
  {
    group: "registry",
    name: "list",
    summary: "List registries in a tenant.",
    run: (args, options) =>
      request(options, `/tenants/${requiredArg(args, "tenantId")}/registries`),
  },
];

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help || !parsed.group) {
    printHelp();
    return;
  }

  if (parsed.group === "login") {
    printResult(login(parsed.options), parsed.options.output);
    return;
  }

  if (parsed.group === "logout") {
    printResult(logout(), parsed.options.output);
    return;
  }

  const command = commands.find(
    (candidate) =>
      candidate.group === parsed.group && candidate.name === parsed.command,
  );

  if (!command) {
    throw new Error(`Unknown command: ${[parsed.group, parsed.command].filter(Boolean).join(" ")}`);
  }

  const result = await command.run(parsed.args, parsed.options);
  printResult(result, parsed.options.output);
}

function parseArgs(argv: string[]) {
  const config = readConfig();
  const options: GlobalOptions = {
    apiUrl:
      process.env.RESOURCE_PORTAL_API_URL ??
      config.apiUrl ??
      "http://localhost:3000/api",
    token: process.env.RESOURCE_PORTAL_TOKEN ?? config.token,
    output: "table",
  };
  const positional: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--api-url") {
      options.apiUrl = requiredOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--token") {
      options.token = requiredOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      options.output = parseOutput(requiredOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  return {
    args: positional.slice(2),
    command: positional[1],
    group: positional[0],
    help,
    options,
  };
}

function login(options: GlobalOptions) {
  if (!options.token) {
    throw new Error("Missing token. Use rp login --token TOKEN");
  }

  writeConfig({
    apiUrl: options.apiUrl,
    token: options.token,
  });

  return {
    apiUrl: options.apiUrl,
    status: "LoggedIn",
  };
}

function logout() {
  const path = configPath();

  if (existsSync(path)) {
    rmSync(path);
  }

  return {
    status: "LoggedOut",
  };
}

async function request(options: GlobalOptions, path: string) {
  const response = await fetch(`${options.apiUrl.replace(/\/$/, "")}${path}`, {
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
  });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return payload;
}

function printResult(result: unknown, output: OutputFormat) {
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

  if (records.length === 0) {
    return;
  }

  const columns = Array.from(
    new Set(records.flatMap((row) => Object.keys(row).slice(0, 8))),
  );
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...records.map((row) => formatCell(row[column]).length),
    ),
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
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function printHelp() {
  console.log("Resource Portal CLI");
  console.log("");
  console.log("Usage:");
  console.log("  rp <group> <command> [args] [--api-url URL] [--token TOKEN] [-o table|json]");
  console.log("  rp login --api-url URL --token TOKEN");
  console.log("  rp logout");
  console.log("");
  console.log("Commands:");
  console.log("  login  Save API URL and bearer token locally.");
  console.log("  logout  Remove the local CLI profile.");

  for (const command of commands) {
    console.log(`  ${command.group} ${command.name}  ${command.summary}`);
  }
}

function readConfig(): CliConfig {
  const path = configPath();

  if (!existsSync(path)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: CliConfig) {
  const path = configPath();

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function configPath() {
  return join(homedir(), ".resourceportal", "config.json");
}

function requiredArg(args: string[], name: string, index = 0) {
  const value = args[index];

  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }

  return encodeURIComponent(value);
}

function requiredOptionValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

function parseOutput(value: string): OutputFormat {
  if (value === "json" || value === "table") {
    return value;
  }

  throw new Error("--output must be json or table");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
