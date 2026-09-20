import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { StackRuntimeService } from "./stack-runtime.service";

function dockerProcess(stdout = "", exitCode = 0, stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", exitCode, null);
  });
  return child;
}

function service() {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "TRAEFIK_SERVICE_NAME") {
        return "resourceportal-control-plane_traefik";
      }
      return fallback;
    }),
  };
  return new StackRuntimeService(config as unknown as ConfigService);
}

describe("StackRuntimeService v0.2 App Group networking", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("removes stale and publishes changed/missing Traefik labels in one update", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        dockerProcess(
          JSON.stringify({
            "com.example.keep": "yes",
            "traefik.http.routers.old.rule": "Host(`old.example.com`)",
            "traefik.http.routers.web.rule": "Host(`old-web.example.com`)",
          }),
        ),
      )
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileTraefikLabels({
      serviceName: "rp_stack_web",
      desiredLabels: {
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
        "traefik.enable": "true",
      },
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "service",
        "update",
        "--label-rm",
        "traefik.http.routers.old.rule",
        "--label-add",
        "traefik.http.routers.web.rule=Host(`app.example.com`)",
        "--label-add",
        "traefik.enable=true",
        "rp_stack_web",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("is idempotent when current and desired Traefik labels match", async () => {
    spawnMock.mockImplementationOnce(() =>
      dockerProcess(
        JSON.stringify({
          "traefik.enable": "true",
          "traefik.http.routers.web.rule": "Host(`app.example.com`)",
        }),
      ),
    );

    const result = await service().reconcileTraefikLabels({
      serviceName: "rp_stack_web",
      desiredLabels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
      },
    });

    expect(result).toEqual({ success: true, changed: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("creates one managed App Group overlay and attaches Traefik for a public group", async () => {
    const networkName = "rp-appgroup-11111111-1111-4111-8111-111111111111";
    spawnMock
      .mockImplementationOnce(() => dockerProcess("", 1, "No such network"))
      .mockImplementationOnce(() => dockerProcess("new-network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("base-network-id"))
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileAppGroupNetwork({
      networkName,
      traefikRequired: true,
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "network",
      "create",
      "--driver",
      "overlay",
      "--label",
      "resourceportal.managed=true",
      "--label",
      "resourceportal.network.kind=app-group",
      networkName,
    ]);
    expect(spawnMock.mock.calls[4]?.[1]).toEqual([
      "service",
      "update",
      "--network-add",
      networkName,
      "resourceportal-control-plane_traefik",
    ]);
  });

  it("keeps the App Group network but detaches Traefik when the group becomes private", async () => {
    const networkName = "rp-appgroup-11111111-1111-4111-8111-111111111111";
    spawnMock
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id\nbase-network-id"))
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileAppGroupNetwork({
      networkName,
      traefikRequired: false,
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock.mock.calls[3]?.[1]).toEqual([
      "service",
      "update",
      "--network-rm",
      networkName,
      "resourceportal-control-plane_traefik",
    ]);
    expect(
      spawnMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("rm") && (call[1] as string[])[0] === "network",
      ),
    ).toBe(false);
  });

  it("detaches Traefik and removes only the obsolete legacy ingress overlay", async () => {
    const networkName = "rp-ingress-11111111-1111-4111-8111-111111111111";
    spawnMock
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id\nbase-network-id"))
      .mockImplementationOnce(() => dockerProcess())
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileLegacyIngressNetwork({
      networkName,
      required: false,
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock.mock.calls[3]?.[1]).toEqual([
      "service",
      "update",
      "--network-rm",
      networkName,
      "resourceportal-control-plane_traefik",
    ]);
    expect(spawnMock.mock.calls[4]?.[1]).toEqual([
      "network",
      "rm",
      networkName,
    ]);
  });

  it("can still recreate a legacy ingress overlay for exact v0.1.x artifact recovery", async () => {
    const networkName = "rp-ingress-11111111-1111-4111-8111-111111111111";
    spawnMock
      .mockImplementationOnce(() => dockerProcess("", 1, "No such network"))
      .mockImplementationOnce(() => dockerProcess("new-network-id"))
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("base-network-id"))
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileLegacyIngressNetwork({
      networkName,
      required: true,
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock.mock.calls[1]?.[1]).toContain(
      "resourceportal.network.kind=app-group-ingress-legacy",
    );
  });

  it("attaches a tenant service to the single App Group network", async () => {
    const networkName = "rp-appgroup-11111111-1111-4111-8111-111111111111";
    spawnMock
      .mockImplementationOnce(() => dockerProcess("network-id"))
      .mockImplementationOnce(() => dockerProcess("private-network-id"))
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileServiceNetwork({
      serviceName: "rp_stack_web",
      networkName,
      required: true,
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      "service",
      "update",
      "--network-add",
      networkName,
      "rp_stack_web",
    ]);
  });

  it("refuses to mutate a network outside ResourcePortal tenant namespaces", async () => {
    await expect(
      service().reconcileAppGroupNetwork({
        networkName: "rp-control",
        traefikRequired: true,
      }),
    ).rejects.toThrow("Refusing unmanaged App Group network");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
