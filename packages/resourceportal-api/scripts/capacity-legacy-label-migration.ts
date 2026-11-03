/**
 * Explicit operator-only migration for legacy Swarm task-template identity labels.
 * Never invoked during a control-plane upgrade: every change restarts tasks.
 *
 * Run once without --apply to generate a SHA-bound reviewable plan; execute per
 * AppGroup with --apply --group-id ... --approve-sha256 ... --audit-file ... .
 */
import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, writeSync, constants as fsConstants } from "node:fs";
import http from "node:http";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient } from "@prisma/client";
import { parse as parseYaml } from "yaml";

const LABEL = "resourceportal.single-app-id";
const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACTIVE_DEPLOYMENTS = ["Pending", "Deploying", "RollingBack"] as const;

type DockerService = {
  ID: string;
  Version: { Index: number };
  Spec: {
    Name: string;
    Labels?: Record<string, string>;
    Mode?: { Replicated?: { Replicas?: number } };
    TaskTemplate: { ContainerSpec: { Image: string; Labels?: Record<string, string> } };
  };
  UpdateStatus?: { State?: string; Message?: string };
};
type MigrationPlanEntry = {
  serviceId: string;
  serviceName: string;
  serviceVersion: number;
  tenantId: string;
  appGroupId: string;
  singleAppId: string;
  deploymentVersion: number;
  replicas: number;
  image: string;
  action: "migrate" | "skip";
};

function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function serviceName(appGroupId: string, singleAppName: string): string {
  assert(UUID.test(appGroupId), "Invalid AppGroup identifier");
  assert(singleAppName.length > 0, "Missing SingleApp name");
  return `rp_${appGroupId.replaceAll("-", "_")}_${singleAppName.replaceAll("-", "_")}`;
}

export function validateLegacyService(
  live: DockerService,
  entry: Omit<MigrationPlanEntry, "action" | "serviceVersion" | "replicas" | "image" | "deploymentVersion">,
  publishedImage: string,
): "migrate" | "skip" {
  assert(live.ID === entry.serviceId && live.Spec.Name === entry.serviceName, "Service identity changed");
  assert(Number.isSafeInteger(live.Version.Index), "Missing service version");
  const stack = `rp_${entry.appGroupId.replaceAll("-", "_")}`;
  assert(live.Spec.Labels?.["com.docker.stack.namespace"] === stack, "Service does not belong to the published RP stack");
  const actualImage = live.Spec.TaskTemplate?.ContainerSpec?.Image;
  assert(typeof actualImage === "string" &&
    (actualImage === publishedImage || actualImage.startsWith(`${publishedImage}@sha256:`)),
  "Live image differs from the published deployment");
  for (const labels of [live.Spec.Labels, live.Spec.TaskTemplate.ContainerSpec.Labels]) {
    for (const [key, value] of [
      ["resourceportal.tenant-id", entry.tenantId],
      ["resourceportal.app-group-id", entry.appGroupId],
      [LABEL, entry.singleAppId],
    ]) {
      assert(!labels?.[key] || labels[key] === value, `Conflicting RP ownership label ${key}`);
    }
  }
  const replicas = live.Spec.Mode?.Replicated?.Replicas;
  assert(Number.isInteger(replicas) && replicas! > 0, "Only active replicated services can be migrated");
  return live.Spec.TaskTemplate.ContainerSpec.Labels?.[LABEL] === entry.singleAppId ? "skip" : "migrate";
}

/** A draft name is not a published Swarm service identity. Fail closed on pending edits. */
export function assertPublishedNamesUnchanged(hasPendingChanges: boolean): void {
  assert(!hasPendingChanges, "AppGroup has pending draft changes; migrate only the published deployment");
}

/** Swarm object versions are globally assigned, not consecutive per service. */
export function assertExpectedRolloutSpec(
  current: DockerService,
  expectedSpec: DockerService["Spec"],
  previousVersion: number,
): void {
  assert(Number.isSafeInteger(current.Version.Index) && current.Version.Index > previousVersion,
    "Swarm service version did not advance after migration update");
  assert(isDeepStrictEqual(current.Spec, expectedSpec), "Another Swarm update changed the service spec during migration");
}

export function planHash(entries: MigrationPlanEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function docker<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise<T>((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      method,
      path: `/v1.43${path}`,
      timeout: 10_000,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 10_000_000) {
          res.destroy(new Error("Docker response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const status = res.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new Error(`Docker API ${method} ${path.split("?")[0]} returned HTTP ${status}`));
          return;
        }
        try { resolve(Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as T : undefined as T); }
        catch { reject(new Error("Docker returned invalid JSON")); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Docker request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function getService(serviceNameOrId: string): Promise<DockerService> {
  return docker<DockerService>("GET", `/services/${encodeURIComponent(serviceNameOrId)}`);
}

async function getRunningLabeledTaskCount(serviceId: string, expectedAppId: string): Promise<number> {
  const filters = encodeURIComponent(JSON.stringify({ service: [serviceId] }));
  const tasks = await docker<Array<{ ServiceID: string; DesiredState: string; Status?: { State?: string }; Spec?: { ContainerSpec?: { Labels?: Record<string, string> } } }>>("GET", `/tasks?filters=${filters}`);
  return tasks.filter((task) => task.ServiceID === serviceId &&
    task.DesiredState === "running" && task.Status?.State === "running" &&
    task.Spec?.ContainerSpec?.Labels?.[LABEL] === expectedAppId).length;
}

async function safePlan(db: PrismaClient, groupId?: string): Promise<MigrationPlanEntry[]> {
  const groups = await db.appGroup.findMany({
    where: { ...(groupId ? { id: groupId } : {}), runtimeState: "Running", currentDeploymentVersion: { not: null } },
    include: { singleApps: true },
    orderBy: { id: "asc" },
  });
  const entries: MigrationPlanEntry[] = [];
  const serviceNames = new Set<string>();
  for (const group of groups) {
    // Draft SingleApp names can be different from those in the published stack.
    // Do not guess immutable IDs from live service names while edits are pending.
    assertPublishedNamesUnchanged(group.hasPendingChanges);
    const published = await db.appGroupDeployment.findFirst({
      where: { appGroupId: group.id, version: group.currentDeploymentVersion!, status: "Succeeded" },
      select: { renderedStack: true },
    });
    assert(published?.renderedStack, `Missing successful rendered deployment for AppGroup ${group.id}`);
    const stack = parseYaml(published.renderedStack) as { services?: Record<string, { image?: string }> };
    assert(stack && typeof stack.services === "object" && stack.services !== null, "Invalid published stack artifact");
    const activeCount = await db.appGroupDeployment.count({
      where: { appGroupId: group.id, status: { in: [...ACTIVE_DEPLOYMENTS] } },
    });
    assert(activeCount === 0, `Active deployment in AppGroup ${group.id}; aborting migration preview`);
    for (const app of group.singleApps.filter((item) => item.runtimeState === "Running" && item.actualReplicas > 0)) {
      const composeKey = app.name.replaceAll("-", "_");
      const image = stack.services[composeKey]?.image;
      assert(typeof image === "string" && image.length > 0, `Unmapped deployed SingleApp ${app.id}`);
      const name = serviceName(group.id, app.name);
      assert(!serviceNames.has(name), `Ambiguous service name ${name}`);
      serviceNames.add(name);
      const live = await getService(name);
      const entry = {
        serviceId: live.ID,
        serviceName: name,
        tenantId: group.tenantId,
        appGroupId: group.id,
        singleAppId: app.id,
      };
      const action = validateLegacyService(live, entry, image);
      entries.push({ ...entry, deploymentVersion: group.currentDeploymentVersion!, serviceVersion: live.Version.Index,
        replicas: live.Spec.Mode?.Replicated?.Replicas ?? 0, image: live.Spec.TaskTemplate.ContainerSpec.Image, action });
    }
  }
  return entries.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

function appendAudit(fd: number, entry: Record<string, unknown>): void {
  writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

async function applyOne(db: PrismaClient, entry: MigrationPlanEntry, fd: number): Promise<void> {
  // Recheck both the database deployment lease and immutable Swarm spec version immediately before mutation.
  const group = await db.appGroup.findUnique({ where: { id: entry.appGroupId }, select: { tenantId: true, currentDeploymentVersion: true, hasPendingChanges: true, runtimeState: true } });
  assert(group?.tenantId === entry.tenantId && group.currentDeploymentVersion === entry.deploymentVersion && group.runtimeState === "Running", "Published AppGroup deployment changed");
  assertPublishedNamesUnchanged(group.hasPendingChanges);
  const active = await db.appGroupDeployment.count({
    where: { appGroupId: entry.appGroupId, status: { in: [...ACTIVE_DEPLOYMENTS] } },
  });
  assert(active === 0, "Concurrent AppGroup deployment detected");
  const live = await getService(entry.serviceId);
  assert(live.Version.Index === entry.serviceVersion, "Concurrent Swarm spec mutation detected");
  const action = validateLegacyService(live, entry, entry.image);
  if (action === "skip") return;
  const newSpec = structuredClone(live.Spec);
  newSpec.TaskTemplate.ContainerSpec.Labels = { ...newSpec.TaskTemplate.ContainerSpec.Labels, [LABEL]: entry.singleAppId };
  appendAudit(fd, { event: "update-started", ...entry });
  // Docker Engine's optimistic version check rejects concurrent changes (HTTP 409).
  // Sending the complete existing spec changes only task-template labels, preserving all unrelated policy.
  await docker("POST", `/services/${encodeURIComponent(entry.serviceId)}/update?version=${entry.serviceVersion}`, newSpec);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const current = await getService(entry.serviceId);
    assert(current.ID === entry.serviceId, "Service identity changed during migration");
    assertExpectedRolloutSpec(current, newSpec, entry.serviceVersion);
    const state = current.UpdateStatus?.State;
    if (state === "paused" || state === "rollback_started" || state === "rollback_paused" || state === "rollback_completed") {
      throw new Error(`Swarm migration rollout did not converge: ${state}`);
    }
    if (state === "completed" && await getRunningLabeledTaskCount(entry.serviceId, entry.singleAppId) >= entry.replicas) {
      appendAudit(fd, { event: "update-completed", ...entry });
      return;
    }
  }
  throw new Error(`Swarm migration rollout timed out: ${entry.serviceId}`);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const apply = args.includes("--apply");
  const groupId = value("--group-id");
  const approved = value("--approve-sha256");
  const auditFile = value("--audit-file");
  if (groupId) assert(UUID.test(groupId), "--group-id must be a UUID");
  if (apply) {
    assert(groupId && approved && /^[a-f0-9]{64}$/.test(approved), "Execution requires --group-id and --approve-sha256 from a fresh preview");
    assert(auditFile?.startsWith("/"), "Execution requires an absolute persistent --audit-file path");
    assert(existsSync(DOCKER_SOCKET), "Docker socket unavailable");
  }
  const db = new PrismaClient();
  try {
    const plan = await safePlan(db, groupId);
    const digest = planHash(plan);
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", sha256: digest,
      impact: "Each migrate action initiates a Swarm task rollout; stateful services will restart",
      entries: plan }, null, 2));
    if (!apply) return;
    assert(plan.length > 0, "No running legacy application replicas found in the selected AppGroup");
    assert(digest === approved, "Preview plan SHA mismatch: service or database state changed");
    const fd = openSync(auditFile!, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try {
      appendAudit(fd, { event: "plan-approved", sha256: digest, groupId, entries: plan.length });
      for (const entry of plan) {
        if (entry.action === "skip") { appendAudit(fd, { event: "already-compliant", ...entry }); continue; }
        try { await applyOne(db, entry, fd); }
        catch (error) {
          appendAudit(fd, { event: "update-failed", serviceId: entry.serviceId, reason: (error as Error).message });
          throw error; // fail closed; never continue with further tenant workloads
        }
      }
    } finally { closeSync(fd); }
  } finally { await db.$disconnect(); }
}

if (require.main === module) {
  main().catch((error) => { console.error(`Capacity label migration stopped: ${(error as Error).message}`); process.exitCode = 1; });
}
