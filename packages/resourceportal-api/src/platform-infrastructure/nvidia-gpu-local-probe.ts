import { spawn } from "node:child_process";
import { parseNvidiaGpuInventory, type NvidiaGpuObservation } from "./nvidia-gpu-observation";

export const NVIDIA_SMI_QUERY = [
  "--query-gpu=uuid,name,pci.bus_id,memory.total,driver_version,temperature.gpu,utilization.gpu,memory.used",
  "--format=csv,noheader,nounits",
] as const;

export type NvidiaProbeResult =
  | { status: "Observed"; devices: NvidiaGpuObservation[] }
  | { status: "Unavailable"; reason: string };

/**
 * Probe LOCAL hardware on a trusted Swarm node. Do not call this from the
 * manager and claim it inspected remote workers. Future node-wide collection
 * must authenticate each node report and bind it to the actual Swarm node ID.
 *
 * A failed probe does not imply there are zero GPUs; callers must preserve
 * existing inventory and ownership.
 */
export async function probeLocalNvidiaGpus(
  timeoutMs = 8000,
): Promise<NvidiaProbeResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    return { status: "Unavailable", reason: "InvalidProbeTimeout" };
  }
  return new Promise<NvidiaProbeResult>((resolve) => {
    const child = spawn("nvidia-smi", [...NVIDIA_SMI_QUERY], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    });
    const output: Buffer[] = [];
    let size = 0;
    let settled = false;
    const complete = (value: NvidiaProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      complete({ status: "Unavailable", reason: "ProbeTimeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256_000) {
        child.kill("SIGKILL");
        complete({ status: "Unavailable", reason: "ProbeOutputExceeded" });
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", () => { /* Never retain or return possibly sensitive host stderr. */ });
    child.on("error", () => {
      complete({ status: "Unavailable", reason: "ProbeExecutionFailed" });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        return complete({ status: "Unavailable", reason: "ProbeExitFailure" });
      }
      const devices = parseNvidiaGpuInventory(Buffer.concat(output).toString("utf8"));
      if (!devices) {
        return complete({ status: "Unavailable", reason: "MalformedGpuObservation" });
      }
      complete({ status: "Observed", devices });
    });
  });
}
