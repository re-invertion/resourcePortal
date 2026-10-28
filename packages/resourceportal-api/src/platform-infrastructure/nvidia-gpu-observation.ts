/**
 * Trusted-node NVIDIA inventory parsing.
 *
 * A Swarm node label is not proof of a usable GPU. Call this parser only on
 * stdout from a successful local nvidia-smi process on the observed node.
 * Failed commands, truncated rows, duplicate UUIDs and malformed values
 * invalidate the observation; the caller must retain the last known inventory
 * and must not release any previous assignment.
 */
export type NvidiaGpuObservation = {
  uuid: string;
  vendor: "NVIDIA";
  model: string;
  pciBusId: string;
  memoryBytes: string;
  driverVersion: string;
  temperatureCelsius: number | null;
  utilizationPercent: number | null;
  memoryUsedBytes: string | null;
};

const UUID_RE = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PCI_RE = /^(?:[0-9a-f]{4,8}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;
const MIB = 1024n * 1024n;

function csvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (quoted) {
      if (character === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === ",") {
      fields.push(field.trim());
      field = "";
      afterQuote = false;
    } else if (character === '"' && !field.trim() && !afterQuote) {
      quoted = true;
    } else if (afterQuote && character.trim()) {
      return null;
    } else if (character === '"' || character === "\r") {
      return null;
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}

function mibToBytes(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return (BigInt(value) * MIB).toString();
}

function optionalNumber(value: string, max: number): number | null | undefined {
  if (value === "N/A" || value === "[Not Supported]") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
}

/**
 * Parse stdout of:
 * nvidia-smi --query-gpu=uuid,name,pci.bus_id,memory.total,driver_version,temperature.gpu,utilization.gpu,memory.used --format=csv,noheader,nounits
 *
 * Empty, incomplete or invalid observations fail closed (null), not [].
 */
export function parseNvidiaGpuInventory(stdout: string): NvidiaGpuObservation[] | null {
  if (!stdout.trim() || stdout.length > 256_000) return null;
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length > 128) return null;
  const result: NvidiaGpuObservation[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fields = csvFields(line);
    if (!fields || fields.length !== 8) return null;
    const [uuid, model, pciBusId, totalMiB, driverVersion, temperature, utilization, usedMiB] = fields;
    const memoryBytes = mibToBytes(totalMiB);
    const memoryUsedBytes = usedMiB === "N/A" ? null : mibToBytes(usedMiB);
    const temperatureCelsius = optionalNumber(temperature, 150);
    const utilizationPercent = optionalNumber(utilization, 100);
    if (
      !UUID_RE.test(uuid) || seen.has(uuid.toLowerCase()) ||
      !model || model.length > 256 || !PCI_RE.test(pciBusId) ||
      !/^\d+(?:\.\d+){1,3}$/.test(driverVersion) ||
      memoryBytes === null || BigInt(memoryBytes) === 0n ||
      memoryUsedBytes === null && usedMiB !== "N/A" ||
      (memoryUsedBytes !== null && BigInt(memoryUsedBytes) > BigInt(memoryBytes)) ||
      temperatureCelsius === undefined || utilizationPercent === undefined
    ) return null;
    seen.add(uuid.toLowerCase());
    result.push({
      uuid, vendor: "NVIDIA", model, pciBusId, memoryBytes, driverVersion,
      temperatureCelsius, utilizationPercent, memoryUsedBytes,
    });
  }
  return result;
}

export type GpuAllocationStatus = "Available" | "Allocated" | "Unavailable" | "Unsupported";

export function deriveGpuAllocationStatus(input: {
  allocated: boolean;
  nodeSchedulable: boolean;
  runtimeReady: boolean;
  compatible: boolean;
}): GpuAllocationStatus {
  if (input.allocated) return "Allocated";
  if (!input.compatible) return "Unsupported";
  if (!input.nodeSchedulable || !input.runtimeReady) return "Unavailable";
  return "Available";
}
