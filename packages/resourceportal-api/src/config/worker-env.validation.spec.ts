import { describe, expect, it } from "vitest";
import { validateWorkerEnv } from "./worker-env.validation";

const validWorkerEnv = {
  DATABASE_URL: "postgresql://rp:rp@localhost:5432/rp",
  RESOURCE_ENCRYPTION_KEY: "test-key",
};

describe("validateWorkerEnv observability timings", () => {
  it("accepts positive heartbeat and staleness values", () => {
    const env = {
      ...validWorkerEnv,
      WORKER_HEARTBEAT_INTERVAL_MS: "10000",
      WORKER_HEALTH_STALE_SECONDS: "30",
    };
    expect(validateWorkerEnv(env)).toBe(env);
  });

  it("rejects invalid heartbeat and staleness values", () => {
    expect(() =>
      validateWorkerEnv({
        ...validWorkerEnv,
        WORKER_HEARTBEAT_INTERVAL_MS: "0",
        WORKER_HEALTH_STALE_SECONDS: "bad",
      }),
    ).toThrow(
      "WORKER_HEARTBEAT_INTERVAL_MS must be a positive integer; WORKER_HEALTH_STALE_SECONDS must be a positive integer",
    );
  });
});
