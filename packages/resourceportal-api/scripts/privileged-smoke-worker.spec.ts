import { describe, expect, it } from "vitest";
import {
  privilegedSmokeCommandArgs,
  privilegedSmokeWorkerArgs,
} from "./privileged-smoke-worker";

describe("privileged smoke worker environment", () => {
  it("passes only ResourcePortal worker configuration through sudo env", () => {
    const args = privilegedSmokeWorkerArgs(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://rp:test@127.0.0.1/rp",
        RESOURCE_ENCRYPTION_KEY: "test-key",
        RESOURCE_STORAGE_BASE_PATH: "/srv/resource-portal/storage",
        STORAGE_BACKEND_RECONCILE_INTERVAL_MS: "600000",
        DOCKER_CONTEXT: "default",
        WORKER_ONCE: "true",
        WORKER_ID: "smoke-worker",
        INTERNAL_WORKER_TOKEN_FILE: "/run/secrets/internal-worker-token",
        GITHUB_TOKEN: "must-not-be-forwarded",
        AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded",
        npm_execpath: "/npm-cli.js",
      },
      "/node",
      "/npm-cli.js",
    );

    expect(args[0]).toBe("/usr/bin/env");
    expect(args).toContain("DATABASE_URL=postgresql://rp:test@127.0.0.1/rp");
    expect(args).toContain("RESOURCE_ENCRYPTION_KEY=test-key");
    expect(args).toContain("WORKER_ONCE=true");
    expect(args).toContain(
      "INTERNAL_WORKER_TOKEN_FILE=/run/secrets/internal-worker-token",
    );
    expect(args).not.toContain("GITHUB_TOKEN=must-not-be-forwarded");
    expect(args).not.toContain(
      "AWS_SECRET_ACCESS_KEY=must-not-be-forwarded",
    );
    expect(args).not.toContain("npm_execpath=/npm-cli.js");
    expect(args.slice(-4)).toEqual([
      "/node",
      "/npm-cli.js",
      "run",
      "worker",
    ]);
  });

  it("uses the same filtered environment for privileged smoke subcommands", () => {
    const args = privilegedSmokeCommandArgs(
      {
        DATABASE_URL: "postgresql://rp:test@127.0.0.1/rp",
        RESOURCE_ENCRYPTION_KEY: "test-key",
        STORAGE_SMOKE_PRIVILEGED_WORKER: "true",
        GITHUB_TOKEN: "must-not-be-forwarded",
      },
      "/node",
      ["/npm-cli.js", "run", "smoke:volume-lifecycle"],
    );

    expect(args).toContain("DATABASE_URL=postgresql://rp:test@127.0.0.1/rp");
    expect(args).toContain("STORAGE_SMOKE_PRIVILEGED_WORKER=true");
    expect(args).not.toContain("GITHUB_TOKEN=must-not-be-forwarded");
    expect(args.slice(-4)).toEqual([
      "/node",
      "/npm-cli.js",
      "run",
      "smoke:volume-lifecycle",
    ]);
  });
});
