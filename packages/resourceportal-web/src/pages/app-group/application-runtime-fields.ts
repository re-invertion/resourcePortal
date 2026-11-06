/**
 * A SingleApp PATCH must contain only the fields the active editor owns.
 * Rendering/quotas read these exact DTO names from CreateSingleAppDto and
 * UpdateSingleAppDto (PartialType); unrelated values stay unchanged.
 */
export type BasicEdit = {
  name: string;
  description: string;
  image: string;
  registryId: string;
};
export type ComputeEdit = {
  cpu: number;
  memoryMiB: number;
  desiredReplicas: number;
  runtimeState: string;
};
export type AdvancedRuntimeEdit = {
  command: string[];
  readOnlyRootFilesystem: boolean;
  healthEnabled: boolean;
  healthCommand: string;
  healthInterval: number;
  healthTimeout: number;
  healthRetries: number;
  healthStartPeriod: number;
  restartCondition: string;
  restartDelay: number;
  restartMaxAttempts: string;
  restartWindow: string;
  updateParallelism: number;
  updateDelay: number;
  updateOrder: string;
};
export type LegacyAdvancedEdit = {
  entrypoint: string;
  workingDir: string;
  user: string;
  stopGrace: number;
};
type Obj = Record<string, unknown>;
function objectField(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}
function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function optionalInteger(value: unknown): string {
  return Number.isInteger(value) && typeof value === "number" ? String(value) : "";
}
function optionalNonnegativeNumber(value: unknown): string {
  // The Swarm renderer accepts fractional second durations for restart
  // windows; do not erase an existing value during an unrelated PATCH.
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "";
}
function validNumber(name: string, value: number, min: number, max: number, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a ${integer ? "whole " : ""}number between ${min} and ${max}.`);
  }
}
export function initialAdvancedRuntime(app: Obj): AdvancedRuntimeEdit {
  const health = objectField(app.healthCheck);
  const restart = objectField(app.restartPolicy);
  const update = objectField(app.updatePolicy);
  return {
    command: Array.isArray(app.command) && app.command.every(x => typeof x === "string")
      ? [...app.command as string[]] : [],
    readOnlyRootFilesystem: app.readOnlyRootFilesystem === true,
    healthEnabled: typeof health.command === "string" && health.command.trim().length > 0,
    healthCommand: typeof health.command === "string" ? health.command : "",
    healthInterval: numeric(health.intervalSeconds, 30),
    healthTimeout: numeric(health.timeoutSeconds, 10),
    healthRetries: numeric(health.retries, 3),
    healthStartPeriod: numeric(health.startPeriodSeconds, 0),
    restartCondition: typeof restart.condition === "string" ? restart.condition : "any",
    restartDelay: numeric(restart.delaySeconds, 5),
    restartMaxAttempts: optionalInteger(restart.maxAttempts),
    restartWindow: optionalNonnegativeNumber(restart.windowSeconds),
    updateParallelism: numeric(update.parallelism, 1),
    updateDelay: numeric(update.delaySeconds, 10),
    updateOrder: typeof update.order === "string" ? update.order : "start-first",
  };
}
export function basicApplicationPatch(value: BasicEdit): Obj {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) || value.name.length > 63) {
    throw new Error("Name must have 1–63 lowercase letters, digits or single hyphens.");
  }
  if (!value.image.trim() || value.image.length > 512) throw new Error("Image is required and must not exceed 512 characters.");
  if (value.description.length > 1000) throw new Error("Description must not exceed 1000 characters.");
  return {
    name: value.name, description: value.description || null,
    image: value.image, registryId: value.registryId || null,
  };
}
export function computeApplicationPatch(value: ComputeEdit): Obj {
  validNumber("CPU cores", value.cpu, 0.01, 128);
  validNumber("Memory (MiB)", value.memoryMiB, 128, 1048576, true);
  validNumber("Replicas", value.desiredReplicas, 0, 100, true);
  if (value.runtimeState !== "Running" && value.runtimeState !== "Stopped") throw new Error("Invalid desired runtime state.");
  return {
    cpu: value.cpu, memoryBytes: value.memoryMiB * 1048576,
    desiredReplicas: value.desiredReplicas, runtimeState: value.runtimeState,
  };
}
function optionalNonNegativeInteger(label: string, value: string): number | undefined {
  if (value.trim() === "") return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a nonnegative whole number.`);
  const n = Number(value);
  validNumber(label, n, 0, 2147483647, true);
  return n;
}
function optionalNonNegativeSeconds(label: string, value: string): number | undefined {
  if (value.trim() === "") return undefined;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`${label} must be a nonnegative number of seconds.`);
  }
  const n = Number(value);
  validNumber(label, n, 0, 2147483647);
  return n;
}
export function advancedApplicationPatch(
  legacy: LegacyAdvancedEdit,
  advanced: AdvancedRuntimeEdit,
  app: Obj,
): Obj {
  validNumber("Stop grace period (seconds)", legacy.stopGrace, 0, 2147483647, true);
  if (advanced.command.some(arg => typeof arg !== "string" || arg.length === 0)) {
    throw new Error("Every command argument must be nonempty. Remove an unused argument instead.");
  }
  if (advanced.command.some(arg => arg.length > 4096)) throw new Error("Command argument exceeds 4096 characters.");
  if (!["any", "on-failure", "none"].includes(advanced.restartCondition)) throw new Error("Invalid restart condition.");
  if (!["start-first", "stop-first"].includes(advanced.updateOrder)) throw new Error("Invalid update order.");
  validNumber("Restart delay", advanced.restartDelay, 0, 86400);
  validNumber("Update parallelism", advanced.updateParallelism, 0, 1000, true);
  validNumber("Update delay", advanced.updateDelay, 0, 86400);
  if (advanced.healthEnabled) {
    if (!advanced.healthCommand.trim()) throw new Error("Health check shell command is required when enabled.");
    validNumber("Health interval", advanced.healthInterval, 1, 86400);
    validNumber("Health timeout", advanced.healthTimeout, 1, 86400);
    validNumber("Health retries", advanced.healthRetries, 1, 100, true);
    validNumber("Health start period", advanced.healthStartPeriod, 0, 86400);
  }
  const restartPolicy: Obj = { ...objectField(app.restartPolicy), condition: advanced.restartCondition, delaySeconds: advanced.restartDelay };
  const maxAttempts = optionalNonNegativeInteger("Restart max attempts", advanced.restartMaxAttempts);
  const windowSeconds = optionalNonNegativeSeconds("Restart window", advanced.restartWindow);
  if (maxAttempts === undefined) delete restartPolicy.maxAttempts;
  else restartPolicy.maxAttempts = maxAttempts;
  if (windowSeconds === undefined) delete restartPolicy.windowSeconds;
  else restartPolicy.windowSeconds = windowSeconds;
  return {
    entrypoint: legacy.entrypoint || null,
    workingDir: legacy.workingDir || null,
    user: legacy.user || null,
    stopGracePeriodSeconds: legacy.stopGrace,
    // Docker Compose 'command' is an argv array, never a parsed shell string.
    command: [...advanced.command],
    readOnlyRootFilesystem: advanced.readOnlyRootFilesystem,
    // Empty object explicitly clears a previously configured health check.
    healthCheck: advanced.healthEnabled
      ? { ...objectField(app.healthCheck),
          command: advanced.healthCommand,
          intervalSeconds: advanced.healthInterval,
          timeoutSeconds: advanced.healthTimeout,
          retries: advanced.healthRetries,
          startPeriodSeconds: advanced.healthStartPeriod }
      : {},
    restartPolicy,
    updatePolicy: { ...objectField(app.updatePolicy),
      parallelism: advanced.updateParallelism,
      delaySeconds: advanced.updateDelay,
      order: advanced.updateOrder },
  };
}
