import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentArtifactSha256 } from "./deployment-artifact";
import { StackRuntimeService } from "./stack-runtime.service";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { StackApplyService } from "./stack-apply.service";

type DockerChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  capturedInput: () => string;
};

function dockerProcess(stdout = "", exitCode = 0, stderr = "") {
  const chunks: Buffer[] = [];
  const child = new EventEmitter() as DockerChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.capturedInput = () => Buffer.concat(chunks).toString("utf8");
  child.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", exitCode, null);
  });
  return child;
}

function fixture() {
  const runtime = {
    reconcileAppGroupNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
    reconcileLegacyIngressNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
  };
  const config = { get: vi.fn((_key: string, fallback?: unknown) => fallback) };
  return {
    runtime,
    service: new StackApplyService(
      config as unknown as ConfigService,
      runtime as unknown as StackRuntimeService,
    ),
  };
}

const appGroupId = "11111111-1111-4111-8111-111111111111";
const appGroupNetwork = `rp-appgroup-${appGroupId}`;
const legacyIngressNetwork = `rp-ingress-${appGroupId}`;

function publicStack() {
  return `version: "3.9"\nservices:\n  web:\n    image: nginx:alpine\n    networks: [default]\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${appGroupNetwork}\nnetworks:\n  default:\n    external: true\n    name: ${appGroupNetwork}\n`;
}

function privateStack() {
  return `version: "3.9"\nservices:\n  worker:\n    image: busybox\n    networks: [default]\nnetworks:\n  default:\n    external: true\n    name: ${appGroupNetwork}\n`;
}

function legacyPublicStack() {
  return `version: "3.9"\nservices:\n  web:\n    image: nginx:alpine\n    networks: [default, ingress]\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${legacyIngressNetwork}\nnetworks:\n  default:\n    name: ${appGroupNetwork}\n    driver: overlay\n  ingress:\n    external: true\n    name: ${legacyIngressNetwork}\n`;
}

describe("StackApplyService exact deployment artifact", () => {
  beforeEach(() => spawnMock.mockReset());

  it("passes the persisted v0.2 single-network artifact to docker stack deploy byte-for-byte", async () => {
    const renderedStack = publicStack();
    let child: DockerChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      child = dockerProcess("stack updated");
      return child;
    });
    const { service } = fixture();

    const result = await service.applyStack({
      stackName: "rp_11111111_1111_4111_8111_111111111111",
      renderedStack,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result.exitCode).toBe(0);
    expect(child?.capturedInput()).toBe(renderedStack);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("ensures the one App Group network and attaches Traefik before a public v0.2 deploy", async () => {
    const renderedStack = publicStack();
    spawnMock.mockImplementationOnce(() => dockerProcess("stack updated"));
    const { runtime, service } = fixture();

    const result = await service.applyStack({
      stackName: "rp_11111111_1111_4111_8111_111111111111",
      renderedStack,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result.exitCode).toBe(0);
    expect(runtime.reconcileAppGroupNetwork).toHaveBeenCalledWith({
      networkName: appGroupNetwork,
      traefikRequired: true,
    });
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenLastCalledWith({
      networkName: legacyIngressNetwork,
      required: false,
    });
  });

  it("keeps the App Group network for a private stack while detaching Traefik and cleaning legacy ingress", async () => {
    const renderedStack = privateStack();
    spawnMock.mockImplementationOnce(() => dockerProcess("stack updated"));
    const { runtime, service } = fixture();

    const result = await service.applyStack({
      stackName: "rp_11111111_1111_4111_8111_111111111111",
      renderedStack,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result.exitCode).toBe(0);
    expect(runtime.reconcileAppGroupNetwork).toHaveBeenCalledWith({
      networkName: appGroupNetwork,
      traefikRequired: false,
    });
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenCalledWith({
      networkName: legacyIngressNetwork,
      required: false,
    });
  });

  it("replays a historical v0.1.x artifact on its legacy ingress network without rewriting it", async () => {
    const renderedStack = legacyPublicStack();
    let child: DockerChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      child = dockerProcess("legacy stack updated");
      return child;
    });
    const { runtime, service } = fixture();

    const result = await service.applyStack({
      stackName: "rp_11111111_1111_4111_8111_111111111111",
      renderedStack,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result.exitCode).toBe(0);
    expect(child?.capturedInput()).toBe(renderedStack);
    expect(runtime.reconcileAppGroupNetwork).not.toHaveBeenCalled();
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenCalledTimes(1);
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenCalledWith({
      networkName: legacyIngressNetwork,
      required: true,
    });
  });

  it("fails before every side effect when the bytes do not match the persisted digest", async () => {
    const renderedStack = publicStack();
    const { runtime, service } = fixture();

    const result = await service.applyStack({
      stackName: "rp_stack",
      renderedStack: `${renderedStack}\n# mutated after persistence\n`,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result).toMatchObject({
      exitCode: 2,
      command: "verify deployment artifact sha256",
    });
    expect(runtime.reconcileAppGroupNetwork).not.toHaveBeenCalled();
    expect(runtime.reconcileLegacyIngressNetwork).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not deploy when App Group network preparation fails", async () => {
    const renderedStack = publicStack();
    const { runtime, service } = fixture();
    runtime.reconcileAppGroupNetwork.mockResolvedValueOnce({
      success: false,
      changed: false,
    });

    const result = await service.applyStack({
      stackName: "rp_stack",
      renderedStack,
      artifactSha256: deploymentArtifactSha256(renderedStack),
      appGroupId,
    });

    expect(result.exitCode).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
