import { spawn } from "node:child_process";
import {
  parseNvidiaGpuInventory,
  type NvidiaGpuObservation,
} from "./nvidia-gpu-observation";
import { NVIDIA_SMI_QUERY } from "./nvidia-gpu-local-probe";

export type SwarmGpuNodeProbe =
  | { status: "Observed"; swarmNodeId: string; devices: NvidiaGpuObservation[] }
  | { status: "Unavailable"; swarmNodeId: string | null; reason: string };

// Official Ubuntu digest from Docker's documented immutable pull example.
// Runtime injection provides nvidia-smi through the host NVIDIA utility driver,
// avoiding CUDA/driver-version restrictions from a CUDA image.
export const DEFAULT_GPU_PROBE_IMAGE =
  "docker.io/library/ubuntu@sha256:2e863c44b718727c860746568e1d54afd13b2fa71b160f5cd9058fc436217b30";
const SAFE_IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;
const NODE_ID = /^[a-z0-9]{20,40}$/;

/** Runs only predefined Docker commands, on the local trusted node agent. */
async function docker(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const child = spawn("docker", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
    });
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (part: Buffer) => {
      if (output.length + part.length > 256_000) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      output += part.toString("utf8");
    });
    child.stderr.on("data", () => { /* Metadata-only diagnostics. */ });
    child.on("error", () => finish(null));
    child.on("close", (exitCode) => finish(exitCode === 0 ? output.trim() : null));
  });
}

/** Initiated once at agent startup. It never blocks authenticated API calls. */
export async function preloadPinnedGpuProbeImage(): Promise<boolean> {
  // Never pull a GPU probe image onto CPU-only hosts. The same host runtime
  // requirement is checked again for every actual observation.
  const runtime = await docker(["info", "--format", "{{.DefaultRuntime}}"], 4000);
  if (runtime !== "nvidia") return false;
  const image = process.env.RESOURCEPORTAL_GPU_PROBE_IMAGE || DEFAULT_GPU_PROBE_IMAGE;
  if (!SAFE_IMAGE.test(image)) return false;
  const existing = await docker(["image", "inspect", "--format", "{{.Id}}", image], 4000);
  if (existing && /^sha256:[0-9a-f]{64}$/.test(existing)) return true;
  // Docker verifies the requested immutable registry digest. No mutable tags.
  const pulled = await docker(["pull", "--quiet", image], 90_000);
  return Boolean(pulled);
}

/**
 * The probe container is nonprivileged, networkless, short-lived and read-only.
 * No image pull is allowed. The operator-provided image must be digest pinned
 * and locally verified/pulled by the controlled installer.
 *
 * A docker run --gpus all query validates Docker's NVIDIA toolkit path, not
 * just the host's PCI label. It never reserves a tenant GPU for a workload.
 */
export async function probeSwarmNodeGpuRuntime(): Promise<SwarmGpuNodeProbe> {
  const nodeId = await docker(["info", "--format", "{{.Swarm.NodeID}}"], 4000);
  if (!nodeId || !NODE_ID.test(nodeId)) {
    return { status: "Unavailable", swarmNodeId: null, reason: "SwarmNodeIdentityUnavailable" };
  }
  // Swarm service specs do not inherit docker run --gpus. Named generic
  // resources only schedule the service; the default NVIDIA runtime must
  // inject its explicitly selected GPU UUID into the actual task.
  const defaultRuntime = await docker(['info', '--format', '{{.DefaultRuntime}}'], 4000);
  if (defaultRuntime !== 'nvidia') {
    return { status: 'Unavailable', swarmNodeId: nodeId, reason: 'NvidiaNotDefaultRuntime' };
  }
  const image = process.env.RESOURCEPORTAL_GPU_PROBE_IMAGE || DEFAULT_GPU_PROBE_IMAGE;
  if (!SAFE_IMAGE.test(image)) {
    return { status: "Unavailable", swarmNodeId: nodeId, reason: "PinnedGpuProbeImageRequired" };
  }
  const exists = await docker(["image", "inspect", "--format", "{{.Id}}", image], 4000);
  if (!exists || !/^sha256:[0-9a-f]{64}$/.test(exists)) {
    return { status: "Unavailable", swarmNodeId: nodeId, reason: "GpuProbeImageNotInstalled" };
  }
  const stdout = await docker([
    "run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=64", "--memory=256m", "--cpus=0.25",
    "--gpus=all", "--env=NVIDIA_DRIVER_CAPABILITIES=utility,compute",
    "--entrypoint=nvidia-smi", image,
    ...NVIDIA_SMI_QUERY,
  ], 15000);
  if (!stdout) return { status: "Unavailable", swarmNodeId: nodeId, reason: "NvidiaRuntimeProbeFailed" };
  const devices = parseNvidiaGpuInventory(stdout);
  if (!devices) {
    return { status: "Unavailable", swarmNodeId: nodeId, reason: "MalformedNvidiaRuntimeObservation" };
  }
  return { status: "Observed", swarmNodeId: nodeId, devices };
}

/** Container-only GPU occupancy proof on a trusted Swarm node.
 *
 * No user supplied commands or selection are accepted. A failed Docker query
 * yields Unavailable, NEVER "idle". The observed set is read-only metadata.
 */
export type SwarmGpuNodeUsage =
  | { swarmNodeId: string; status: "Verified"; busyAnyGpu: boolean;
      containers: Array<{ serviceName: string | null; uuid: string }> }
  | { swarmNodeId: string | null; status: "Unavailable"; reason: string };

const GPU_UUID_PATTERN = /^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

export async function probeSwarmNodeGpuContainerUsage(): Promise<SwarmGpuNodeUsage> {
  const swarmNodeId = await docker(["info", "--format", "{{.Swarm.NodeID}}"], 4000);
  if (!swarmNodeId || !NODE_ID.test(swarmNodeId)) {
    return { status: "Unavailable", swarmNodeId: null, reason: "SwarmNodeIdentityUnavailable" };
  }
  const output = await docker(["ps", "--no-trunc", "--format", "{{.ID}}"], 5000);
  if (output === null) {
    return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInventoryUnavailable" };
  }
  const ids = output.split("\n").map((id) => id.trim()).filter(Boolean);
  if (ids.length > 256 || new Set(ids).size !== ids.length ||
      ids.some((id) => !CONTAINER_ID_PATTERN.test(id))) {
    return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInventoryInvalid" };
  }

  let busyAnyGpu = false;
  const containers: Array<{ serviceName: string | null; uuid: string }> = [];
  for (const id of ids) {
    const raw = await docker(["inspect", "--format", "{{json .}}", id], 4000);
    if (!raw) {
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectUnavailable" };
    }
    let container: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      container = parsed as Record<string, unknown>;
    } catch {
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectInvalid" };
    }
    const state = container.State as Record<string, unknown> | undefined;
    if (state?.Running !== true) {
      // The Docker inventory raced a container transition: fail closed.
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInventoryChanged" };
    }
    const config = container.Config as Record<string, unknown> | undefined;
    const host = container.HostConfig as Record<string, unknown> | undefined;
    if (!config || !host ||
        (config.Env !== undefined && config.Env !== null && !Array.isArray(config.Env))) {
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectInvalid" };
    }
    const labels = config.Labels as Record<string, unknown> | undefined;
    const rawService = labels?.["com.docker.swarm.service.name"];
    const serviceName = typeof rawService === "string" && /^[a-zA-Z0-9_-]{1,180}$/.test(rawService)
      ? rawService : null;
    const uuids = new Set<string>();
    const gpuEnv = ((config.Env ?? []) as unknown[]).filter(
      (entry): entry is string => typeof entry === "string" &&
        entry.startsWith("NVIDIA_VISIBLE_DEVICES="),
    );
    for (const entry of gpuEnv) {
      const names = entry.slice("NVIDIA_VISIBLE_DEVICES=".length);
      if (names === "all") busyAnyGpu = true;
      else if (names !== "void" && names !== "none" && names !== "") {
        for (const uuid of names.split(",")) {
          if (!GPU_UUID_PATTERN.test(uuid.trim())) busyAnyGpu = true;
          else uuids.add(uuid.trim());
        }
      }
    }
    const requests = host.DeviceRequests;
    if (requests !== undefined && requests !== null && !Array.isArray(requests)) {
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectInvalid" };
    }
    for (const request of (requests ?? []) as unknown[]) {
      if (!request || typeof request !== "object") {
        return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectInvalid" };
      }
      const data = request as Record<string, unknown>;
      const capabilities = JSON.stringify(data.Capabilities ?? []);
      if (data.Driver === "nvidia" || capabilities.includes('"gpu"')) {
        if (!Array.isArray(data.DeviceIDs) || data.DeviceIDs.length === 0) busyAnyGpu = true;
        else for (const uuid of data.DeviceIDs) {
          if (typeof uuid !== "string" || !GPU_UUID_PATTERN.test(uuid)) busyAnyGpu = true;
          else uuids.add(uuid);
        }
      }
    }
    if (host.Devices !== undefined && host.Devices !== null &&
        !Array.isArray(host.Devices)) {
      return { status: "Unavailable", swarmNodeId, reason: "GpuContainerInspectInvalid" };
    }
    if (Array.isArray(host.Devices) &&
        host.Devices.some((device: unknown) => {
          if (!device || typeof device !== "object") return true;
          const value = device as Record<string, unknown>;
          return typeof value.PathOnHost !== "string" ||
            /^\/dev\/nvidia(?:[0-9]+|ctl|uvm.*)$/.test(value.PathOnHost);
        })) busyAnyGpu = true;
    for (const uuid of uuids) containers.push({ serviceName, uuid });
  }
  return { status: "Verified", swarmNodeId, busyAnyGpu, containers };
}
