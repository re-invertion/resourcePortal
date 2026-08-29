#!/usr/bin/env node

import { ResourcePortalApiError, ResourcePortalClient } from "@resource-portal/sdk";
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
type Flags = Record<string, string | number | boolean | string[]>;

type CliConfig = {
  apiUrl?: string;
  devUserId?: string;
  token?: string;
};

type GlobalOptions = {
  apiUrl: string;
  devUserId?: string;
  token?: string;
  output: OutputFormat;
};

type ParsedArgs = {
  args: string[];
  command?: string;
  flags: Flags;
  group?: string;
  help: boolean;
  options: GlobalOptions;
};

type Command = {
  group: string;
  name: string;
  usage: string;
  summary: string;
  run: (parsed: ParsedArgs, client: ResourcePortalClient) => Promise<unknown>;
};

const commands: Command[] = [
  command("account", "show", "", "Show current authenticated account.", (_p, c) =>
    c.account.me(),
  ),
  command("tenant", "list", "", "List tenants.", (_p, c) => c.tenants.list()),
  command("tenant", "show", "<tenantId>", "Show a tenant.", (p, c) =>
    c.tenants.get(arg(p, 0, "tenantId")),
  ),
  command("tenant", "create", "--name NAME --display-name NAME --contact-email EMAIL", "Create a tenant.", (p, c) =>
    c.tenants.create(bodyFromFlags(p.flags, ["name", "displayName", "contactEmail"], ["description"])),
  ),
  command("tenant", "quota", "<tenantId>", "Show tenant quota.", (p, c) =>
    c.tenants.quota(arg(p, 0, "tenantId")),
  ),
  command("tenant", "quota-update", "<tenantId> [quota flags]", "Update tenant quota.", (p, c) =>
    c.tenants.updateQuota(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, [], ["cpu", "memoryBytes", "gpu", "storageBytes", "maxSingleApps", "maxVolumes"])),
  ),
  command("tenant", "auth-policy", "<tenantId>", "Show tenant auth policy.", (p, c) =>
    c.tenants.authPolicy(arg(p, 0, "tenantId")),
  ),
  command("tenant", "auth-policy-update", "<tenantId> [policy flags]", "Update tenant auth policy.", (p, c) =>
    c.tenants.updateAuthPolicy(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, [], ["allowPlatformLogin", "allowTenantIdentityProviders", "requireTenantIdentityProvider"])),
  ),
  command("tenant", "billing", "<tenantId>", "Show tenant billing.", (p, c) =>
    c.tenants.billing(arg(p, 0, "tenantId")),
  ),
  command("tenant", "billing-transactions", "<tenantId>", "List tenant billing transactions.", (p, c) =>
    c.tenants.billingTransactions(arg(p, 0, "tenantId")),
  ),
  command("tenant", "usage-records", "<tenantId>", "List tenant usage records.", (p, c) =>
    c.tenants.usageRecords(arg(p, 0, "tenantId")),
  ),
  command("tenant", "billing-top-up", "<tenantId> --amount N [--reference TEXT]", "Top up tenant billing balance.", (p, c) =>
    c.tenants.topUpBilling(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["amount"], ["reference"])),
  ),
  command("tenant", "roles", "<tenantId>", "List tenant roles.", (p, c) =>
    c.tenants.roles(arg(p, 0, "tenantId")),
  ),
  command("membership", "list", "<tenantId>", "List memberships.", (p, c) =>
    c.tenants.memberships(arg(p, 0, "tenantId")),
  ),
  command("membership", "create", "<tenantId> --user-id ID --role-id ID", "Create membership.", (p, c) =>
    c.tenants.createMembership(arg(p, 0, "tenantId"), {
      userId: flag(p.flags, "userId"),
      roleIds: arrayFlag(p.flags, "roleId"),
    }),
  ),
  command("membership", "update", "<tenantId> <membershipId> [--status STATUS] [--role-id ID]", "Update membership.", (p, c) =>
    c.tenants.updateMembership(arg(p, 0, "tenantId"), arg(p, 1, "membershipId"), optionalBody({
      status: optionalFlag(p.flags, "status"),
      roleIds: optionalArrayFlag(p.flags, "roleId"),
    })),
  ),
  command("membership", "delete", "<tenantId> <membershipId>", "Delete membership.", (p, c) =>
    c.tenants.deleteMembership(arg(p, 0, "tenantId"), arg(p, 1, "membershipId")),
  ),
  command("invitation", "list", "<tenantId>", "List tenant invitations.", (p, c) =>
    c.tenants.invitations(arg(p, 0, "tenantId")),
  ),
  command("invitation", "create", "<tenantId> --email EMAIL --role-id ID", "Create tenant invitation.", (p, c) =>
    c.tenants.createInvitation(arg(p, 0, "tenantId"), {
      email: flag(p.flags, "email"),
      roleIds: arrayFlag(p.flags, "roleId"),
    }),
  ),
  command("invitation", "resend", "<tenantId> <invitationId>", "Resend tenant invitation.", (p, c) =>
    c.tenants.resendInvitation(arg(p, 0, "tenantId"), arg(p, 1, "invitationId")),
  ),
  command("invitation", "delete", "<tenantId> <invitationId>", "Delete tenant invitation.", (p, c) =>
    c.tenants.deleteInvitation(arg(p, 0, "tenantId"), arg(p, 1, "invitationId")),
  ),
  command("invitation", "accept", "--token TOKEN", "Accept tenant invitation.", (p, c) =>
    c.invitations.accept(bodyFromFlags(p.flags, ["token"], [])),
  ),
  command("group", "list", "<tenantId>", "List tenant groups.", (p, c) =>
    c.tenants.groups(arg(p, 0, "tenantId")),
  ),
  command("group", "create", "<tenantId> --name NAME", "Create tenant group.", (p, c) =>
    c.tenants.createGroup(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["name"], ["description"])),
  ),
  command("group", "update", "<tenantId> <groupId> [flags]", "Update tenant group.", (p, c) =>
    c.tenants.updateGroup(arg(p, 0, "tenantId"), arg(p, 1, "groupId"), bodyFromFlags(p.flags, [], ["name", "description"])),
  ),
  command("group", "delete", "<tenantId> <groupId>", "Delete tenant group.", (p, c) =>
    c.tenants.deleteGroup(arg(p, 0, "tenantId"), arg(p, 1, "groupId")),
  ),
  command("group", "member-add", "<tenantId> <groupId> --membership-id ID", "Add tenant group member.", (p, c) =>
    c.tenants.addGroupMember(arg(p, 0, "tenantId"), arg(p, 1, "groupId"), bodyFromFlags(p.flags, ["membershipId"], [])),
  ),
  command("group", "member-remove", "<tenantId> <groupId> <membershipId>", "Remove tenant group member.", (p, c) =>
    c.tenants.removeGroupMember(arg(p, 0, "tenantId"), arg(p, 1, "groupId"), arg(p, 2, "membershipId")),
  ),
  command("group", "role-add", "<tenantId> <groupId> --role-id ID", "Assign tenant group role.", (p, c) =>
    c.tenants.assignGroupRole(arg(p, 0, "tenantId"), arg(p, 1, "groupId"), bodyFromFlags(p.flags, ["roleId"], [])),
  ),
  command("group", "role-remove", "<tenantId> <groupId> <roleId>", "Remove tenant group role.", (p, c) =>
    c.tenants.removeGroupRole(arg(p, 0, "tenantId"), arg(p, 1, "groupId"), arg(p, 2, "roleId")),
  ),
  command("app-group", "list", "<tenantId>", "List app groups.", (p, c) =>
    c.appGroups.list(arg(p, 0, "tenantId")),
  ),
  command("app-group", "show", "<tenantId> <appGroupId>", "Show app group.", (p, c) =>
    c.appGroups.get(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("app-group", "create", "<tenantId> --name NAME", "Create app group.", (p, c) =>
    c.appGroups.create(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["name"], ["description", "runtimeState"])),
  ),
  command("app-group", "start", "<tenantId> <appGroupId>", "Start app group.", (p, c) =>
    c.appGroups.start(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("app-group", "stop", "<tenantId> <appGroupId>", "Stop app group.", (p, c) =>
    c.appGroups.stop(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("app-group", "restart", "<tenantId> <appGroupId>", "Restart app group.", (p, c) =>
    c.appGroups.restart(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("app", "list", "<tenantId> <appGroupId>", "List apps.", (p, c) =>
    c.apps.list(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("app", "create", "<tenantId> <appGroupId> --name NAME --image IMAGE --cpu N --memory-bytes N", "Create app.", (p, c) =>
    c.apps.create(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), appBody(p.flags, true)),
  ),
  command("app", "update", "<tenantId> <appGroupId> <appId> [flags]", "Update app.", (p, c) =>
    c.apps.update(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), appBody(p.flags, false)),
  ),
  command("app", "delete", "<tenantId> <appGroupId> <appId>", "Delete app.", (p, c) =>
    c.apps.delete(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("app", "start", "<tenantId> <appGroupId> <appId>", "Start app.", (p, c) =>
    c.apps.start(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("app", "stop", "<tenantId> <appGroupId> <appId>", "Stop app.", (p, c) =>
    c.apps.stop(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("app", "restart", "<tenantId> <appGroupId> <appId>", "Restart app.", (p, c) =>
    c.apps.restart(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("app", "runtime-config", "<tenantId> <appGroupId> <appId>", "Show runtime config.", (p, c) =>
    c.apps.runtimeConfig(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("app", "runtime-config-update", "<tenantId> <appGroupId> <appId> [--env K=V] [--secret K=V] [--remove-secret NAME]", "Update runtime config.", (p, c) =>
    c.apps.updateRuntimeConfig(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), {
      environment: envObject(p.flags, "env", true),
      secrets: keyValueList(p.flags, "secret").map(([name, value]) => ({ name, value })),
      removeSecrets: optionalArrayFlag(p.flags, "removeSecret"),
    }),
  ),
  collectionListCommand("variable", "variables"),
  collectionListCommand("config", "configs"),
  command("volume", "list", "<tenantId>", "List volumes.", (p, c) =>
    c.volumes.list(arg(p, 0, "tenantId")),
  ),
  command("volume", "show", "<tenantId> <volumeId>", "Show volume.", (p, c) =>
    c.volumes.get(arg(p, 0, "tenantId"), arg(p, 1, "volumeId")),
  ),
  command("volume", "create", "<tenantId> --name NAME --size-bytes N", "Create volume.", (p, c) =>
    c.volumes.create(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["name", "sizeBytes"], ["description"])),
  ),
  command("volume", "resize", "<tenantId> <volumeId> --size-bytes N", "Resize volume.", (p, c) =>
    c.volumes.resize(arg(p, 0, "tenantId"), arg(p, 1, "volumeId"), bodyFromFlags(p.flags, ["sizeBytes"], [])),
  ),
  command("volume", "delete", "<tenantId> <volumeId>", "Delete volume.", (p, c) =>
    c.volumes.delete(arg(p, 0, "tenantId"), arg(p, 1, "volumeId")),
  ),
  command("volume", "attach", "<tenantId> <appGroupId> <appId> --volume-id ID --mount-path PATH --mode ReadWrite|ReadOnly", "Attach volume.", (p, c) =>
    c.volumes.attach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), bodyFromFlags(p.flags, ["volumeId", "mountPath", "mode"], [])),
  ),
  command("volume", "detach", "<tenantId> <appGroupId> <appId> <attachmentId>", "Detach volume.", (p, c) =>
    c.volumes.detach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "attachmentId")),
  ),
  command("endpoint", "list", "<tenantId> <appGroupId> <appId>", "List HTTP endpoints.", (p, c) =>
    c.endpoints.list(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId")),
  ),
  command("endpoint", "show", "<tenantId> <appGroupId> <appId> <endpointId>", "Show HTTP endpoint.", (p, c) =>
    c.endpoints.get(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "endpointId")),
  ),
  command("endpoint", "create", "<tenantId> <appGroupId> <appId> --name NAME --container-port N", "Create HTTP endpoint.", (p, c) =>
    c.endpoints.create(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), bodyFromFlags(p.flags, ["name", "containerPort"], ["protocolMode"])),
  ),
  command("endpoint", "update", "<tenantId> <appGroupId> <appId> <endpointId> [flags]", "Update HTTP endpoint.", (p, c) =>
    c.endpoints.update(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "endpointId"), bodyFromFlags(p.flags, [], ["name", "containerPort", "protocolMode"])),
  ),
  command("endpoint", "delete", "<tenantId> <appGroupId> <appId> <endpointId>", "Delete HTTP endpoint.", (p, c) =>
    c.endpoints.delete(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "endpointId")),
  ),
  command("domain", "list", "<tenantId>", "List domains.", (p, c) =>
    c.domains.list(arg(p, 0, "tenantId")),
  ),
  command("domain", "show", "<tenantId> <domainId>", "Show domain.", (p, c) =>
    c.domains.get(arg(p, 0, "tenantId"), arg(p, 1, "domainId")),
  ),
  command("domain", "create", "<tenantId> --type TYPE [flags]", "Create domain.", (p, c) =>
    c.domains.create(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["type"], ["prefix", "hostname", "customRootDomainId", "subdomain", "httpEndpointId", "tlsEnabled"])),
  ),
  command("domain", "update", "<tenantId> <domainId> [flags]", "Update domain.", (p, c) =>
    c.domains.update(arg(p, 0, "tenantId"), arg(p, 1, "domainId"), bodyFromFlags(p.flags, [], ["httpEndpointId", "tlsEnabled"])),
  ),
  command("domain", "validate", "<tenantId> <domainId>", "Validate domain.", (p, c) =>
    c.domains.validate(arg(p, 0, "tenantId"), arg(p, 1, "domainId")),
  ),
  command("domain", "delete", "<tenantId> <domainId>", "Delete domain.", (p, c) =>
    c.domains.delete(arg(p, 0, "tenantId"), arg(p, 1, "domainId")),
  ),
  command("custom-root-domain", "list", "<tenantId>", "List custom root domains.", (p, c) =>
    c.customRootDomains.list(arg(p, 0, "tenantId")),
  ),
  command("custom-root-domain", "show", "<tenantId> <customRootDomainId>", "Show custom root domain.", (p, c) =>
    c.customRootDomains.get(arg(p, 0, "tenantId"), arg(p, 1, "customRootDomainId")),
  ),
  command("custom-root-domain", "create", "<tenantId> --root-domain DOMAIN", "Create custom root domain.", (p, c) =>
    c.customRootDomains.create(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["rootDomain"], [])),
  ),
  command("custom-root-domain", "update", "<tenantId> <customRootDomainId> [--verification-status STATUS]", "Update custom root domain.", (p, c) =>
    c.customRootDomains.update(arg(p, 0, "tenantId"), arg(p, 1, "customRootDomainId"), bodyFromFlags(p.flags, [], ["verificationStatus"])),
  ),
  command("custom-root-domain", "validate", "<tenantId> <customRootDomainId>", "Validate custom root domain.", (p, c) =>
    c.customRootDomains.validate(arg(p, 0, "tenantId"), arg(p, 1, "customRootDomainId")),
  ),
  command("custom-root-domain", "delete", "<tenantId> <customRootDomainId>", "Delete custom root domain.", (p, c) =>
    c.customRootDomains.delete(arg(p, 0, "tenantId"), arg(p, 1, "customRootDomainId")),
  ),
  command("registry", "list", "<tenantId>", "List registries.", (p, c) =>
    c.registries.list(arg(p, 0, "tenantId")),
  ),
  command("registry", "show", "<tenantId> <registryId>", "Show registry.", (p, c) =>
    c.registries.get(arg(p, 0, "tenantId"), arg(p, 1, "registryId")),
  ),
  command("registry", "create", "<tenantId> --name NAME --host HOST", "Create registry.", (p, c) =>
    c.registries.create(arg(p, 0, "tenantId"), bodyFromFlags(p.flags, ["name", "host"], ["description", "tlsMode", "authType", "username", "credential"])),
  ),
  command("registry", "update", "<tenantId> <registryId> [flags]", "Update registry.", (p, c) =>
    c.registries.update(arg(p, 0, "tenantId"), arg(p, 1, "registryId"), bodyFromFlags(p.flags, [], ["name", "host", "description", "tlsMode", "authType", "username", "credential"])),
  ),
  command("registry", "validate", "<tenantId> <registryId>", "Validate registry.", (p, c) =>
    c.registries.validate(arg(p, 0, "tenantId"), arg(p, 1, "registryId")),
  ),
  command("registry", "delete", "<tenantId> <registryId>", "Delete registry.", (p, c) =>
    c.registries.delete(arg(p, 0, "tenantId"), arg(p, 1, "registryId")),
  ),
  command("deployment", "list", "<tenantId> <appGroupId>", "List deployments.", (p, c) =>
    c.deployments.list(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  ),
  command("deployment", "show", "<tenantId> <appGroupId> <deploymentId>", "Show deployment.", (p, c) =>
    c.deployments.get(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "deploymentId")),
  ),
  command("deployment", "events", "<tenantId> <appGroupId> <deploymentId>", "List deployment events.", (p, c) =>
    c.deployments.events(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "deploymentId")),
  ),
  command("deployment", "create", "<tenantId> <appGroupId> [--note TEXT] [--force] [--idempotency-key KEY]", "Create deployment.", (p, c) =>
    c.deployments.create(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), bodyFromFlags(p.flags, [], ["note", "force", "correlationId"]), optionalString(p.flags["idempotencyKey"])),
  ),
  command("deployment", "rollback", "<tenantId> <appGroupId> <deploymentId> [--note TEXT]", "Rollback deployment.", (p, c) =>
    c.deployments.rollback(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "deploymentId"), bodyFromFlags(p.flags, [], ["note", "correlationId"]), optionalString(p.flags["idempotencyKey"])),
  ),
  command("audit", "list", "<tenantId>", "List tenant audit log.", (p, c) =>
    c.auditLog.list(arg(p, 0, "tenantId")),
  ),
];

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help || !parsed.group) {
    printHelp(parsed);
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

  const found = commands.find(
    (candidate) =>
      candidate.group === parsed.group && candidate.name === parsed.command,
  );

  if (!found) {
    throw new Error(
      `Unknown command: ${[parsed.group, parsed.command].filter(Boolean).join(" ")}`,
    );
  }

  const client = new ResourcePortalClient({
    apiUrl: parsed.options.apiUrl,
    devUserId: parsed.options.devUserId,
    token: parsed.options.token,
  });
  const result = await found.run(parsed, client);
  printResult(result, parsed.options.output);
}

function command(
  group: string,
  name: string,
  usage: string,
  summary: string,
  run: Command["run"],
): Command {
  return { group, name, usage, summary, run };
}

function collectionListCommand(
  group: "variable" | "config",
  sdkKey: "variables" | "configs",
): Command {
  return command(group, "list", "<tenantId> <appGroupId>", `List ${sdkKey}.`, (p, c) =>
    c[sdkKey].list(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId")),
  );
}

commands.push(
  command("variable", "create", "<tenantId> <appGroupId> --name NAME --value VALUE", "Create variable.", (p, c) =>
    c.variables.create(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), bodyFromFlags(p.flags, ["name", "value"], ["description"])),
  ),
  command("variable", "update", "<tenantId> <appGroupId> <variableId> [flags]", "Update variable.", (p, c) =>
    c.variables.update(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "variableId"), bodyFromFlags(p.flags, [], ["name", "value", "description"])),
  ),
  command("variable", "delete", "<tenantId> <appGroupId> <variableId>", "Delete variable.", (p, c) =>
    c.variables.delete(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "variableId")),
  ),
  command("variable", "attach", "<tenantId> <appGroupId> <appId> --variable-id ID --target-name NAME", "Attach variable.", (p, c) =>
    c.variables.attach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), bodyFromFlags(p.flags, ["variableId", "targetName"], [])),
  ),
  command("variable", "detach", "<tenantId> <appGroupId> <appId> <attachmentId>", "Detach variable.", (p, c) =>
    c.variables.detach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "attachmentId")),
  ),
  command("config", "create", "<tenantId> <appGroupId> --name NAME --content TEXT", "Create config.", (p, c) =>
    c.configs.create(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), bodyFromFlags(p.flags, ["name", "content"], ["description"])),
  ),
  command("config", "update", "<tenantId> <appGroupId> <configId> [flags]", "Update config.", (p, c) =>
    c.configs.update(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "configId"), bodyFromFlags(p.flags, [], ["name", "content", "description"])),
  ),
  command("config", "delete", "<tenantId> <appGroupId> <configId>", "Delete config.", (p, c) =>
    c.configs.delete(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "configId")),
  ),
  command("config", "attach", "<tenantId> <appGroupId> <appId> --config-id ID --target-path PATH", "Attach config.", (p, c) =>
    c.configs.attach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), bodyFromFlags(p.flags, ["configId", "targetPath"], [])),
  ),
  command("config", "detach", "<tenantId> <appGroupId> <appId> <attachmentId>", "Detach config.", (p, c) =>
    c.configs.detach(arg(p, 0, "tenantId"), arg(p, 1, "appGroupId"), arg(p, 2, "appId"), arg(p, 3, "attachmentId")),
  ),
);

function parseArgs(argv: string[]): ParsedArgs {
  const config = readConfig();
  const options: GlobalOptions = {
    apiUrl:
      process.env.RESOURCE_PORTAL_API_URL ??
      config.apiUrl ??
      "http://localhost:3000/api",
    devUserId: process.env.RESOURCE_PORTAL_DEV_USER_ID ?? config.devUserId,
    token: process.env.RESOURCE_PORTAL_TOKEN ?? config.token,
    output: "table",
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

    if (raw === "--output" || raw === "-o") {
      options.output = parseOutput(requiredOptionValue(argv, index, raw));
      index += 1;
      continue;
    }

    if (raw.startsWith("--")) {
      const key = camelCase(raw.slice(2));
      const next = argv[index + 1];
      const value = !next || next.startsWith("--") ? true : coerce(next);

      if (value !== true) {
        index += 1;
      }

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

function login(options: GlobalOptions) {
  if (!options.token && !options.devUserId) {
    throw new Error("Missing credentials. Use --token TOKEN or --dev-user-id USER_ID");
  }

  writeConfig({
    apiUrl: options.apiUrl,
    devUserId: options.devUserId,
    token: options.token,
  });
  return { apiUrl: options.apiUrl, status: "LoggedIn" };
}

function logout() {
  const path = configPath();

  if (existsSync(path)) {
    rmSync(path);
  }

  return { status: "LoggedOut" };
}

function bodyFromFlags(flags: Flags, required: string[], optional: string[]) {
  const body: Record<string, unknown> = {};

  for (const key of required) {
    body[key] = flag(flags, key);
  }

  for (const key of optional) {
    const value = flags[key];

    if (value !== undefined) {
      body[key] = value;
    }
  }

  return body;
}

function appBody(flags: Flags, requireCore: boolean) {
  const body = bodyFromFlags(
    flags,
    requireCore ? ["name", "image", "cpu", "memoryBytes"] : [],
    [
      "name",
      "description",
      "image",
      "registryId",
      "desiredReplicas",
      "runtimeState",
      "cpu",
      "memoryBytes",
      "gpu",
      "entrypoint",
      "workingDir",
      "user",
      "readOnlyRootFilesystem",
      "stopGracePeriodSeconds",
    ],
  );
  const environment = envObject({ env: flags.env }, "env", false);

  if (environment) {
    body.environment = environment;
  }

  return body;
}

function optionalBody(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function envObject(flags: Flags, key: string, nullable: boolean) {
  const entries = keyValueList(flags, key);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map(([name, value]) => [name, nullable && value === "null" ? null : value]),
  );
}

function keyValueList(flags: Flags, key: string) {
  return arrayFlag(flags, key, false).map((entry) => {
    const index = entry.indexOf("=");

    if (index === -1) {
      throw new Error(`--${kebabCase(key)} must use KEY=VALUE`);
    }

    return [entry.slice(0, index), entry.slice(index + 1)] as const;
  });
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

function printHelp(parsed: ParsedArgs) {
  console.log("Resource Portal CLI");
  console.log("");
  console.log("Usage:");
  console.log("  rp login --api-url URL --token TOKEN");
  console.log("  rp login --api-url URL --dev-user-id USER_ID");
  console.log("  rp logout");
  console.log("  rp <group> <command> [args] [flags] [-o table|json]");
  console.log("");
  console.log("Commands:");

  const filtered = parsed.group
    ? commands.filter((item) => item.group === parsed.group)
    : commands;

  for (const item of filtered) {
    console.log(`  ${item.group} ${item.name} ${item.usage}  ${item.summary}`);
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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configPath() {
  return join(homedir(), ".resourceportal", "config.json");
}

function arg(parsed: ParsedArgs, index: number, name: string) {
  const value = parsed.args[index];

  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }

  return value;
}

function flag(flags: Flags, key: string) {
  const value = optionalFlag(flags, key);

  if (value === undefined) {
    throw new Error(`Missing required flag: --${kebabCase(key)}`);
  }

  return value;
}

function optionalFlag(flags: Flags, key: string) {
  const value = flags[key];

  if (Array.isArray(value)) {
    return value[value.length - 1];
  }

  return value;
}

function arrayFlag(flags: Flags, key: string, required = true) {
  const value = flags[key];

  if (value === undefined) {
    if (required) {
      throw new Error(`Missing required flag: --${kebabCase(key)}`);
    }

    return [];
  }

  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function optionalArrayFlag(flags: Flags, key: string) {
  return flags[key] === undefined ? undefined : arrayFlag(flags, key, false);
}

function optionalString(value: unknown) {
  return value === undefined || Array.isArray(value) ? undefined : String(value);
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

function appendFlag(
  flags: Flags,
  key: string,
  value: string | number | boolean,
) {
  const existing = flags[key];

  if (existing === undefined) {
    flags[key] = value;
    return;
  }

  flags[key] = Array.isArray(existing) ? [...existing, String(value)] : [String(existing), String(value)];
}

function coerce(value: string) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function camelCase(value: string) {
  return value.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  if (error instanceof ResourcePortalApiError) {
    console.error(`${error.message}: ${JSON.stringify(error.payload)}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }

  process.exitCode = 1;
});
