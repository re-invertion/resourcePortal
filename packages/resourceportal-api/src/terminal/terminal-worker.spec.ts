import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ContainerTerminalWorker } from "./terminal-worker";

const service = "rp_22222222_2222_4222_8222_222222222222_healthy";
const container = "a".repeat(12);
const actor = "b".repeat(64);

describe("Docker shell broker containment", () => {
  function worker() {
    const shell = new PassThrough();
    const serviceWorker = new ContainerTerminalWorker();
    Object.defineProperty(serviceWorker, "containers", { value: vi.fn().mockResolvedValue([container]) });
    Object.defineProperty(serviceWorker, "shell", { value: vi.fn().mockResolvedValue({ socket: shell, execId: "c".repeat(64) }) });
    return { serviceWorker, shell };
  }

  it("requires a running container of the target service even for an explicit ID", async () => {
    const { serviceWorker } = worker();
    await expect(serviceWorker.handle({ action: "start", actor, service, container: "f".repeat(12) }))
      .rejects.toThrow("not a running task");
  });
  it("binds session read/write/close to the original actor and Swarm service", async () => {
    const { serviceWorker, shell } = worker();
    const start = await serviceWorker.handle({ action: "start", actor, service, container }) as { sessionId: string };
    expect(start.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(serviceWorker.handle({ action: "read", actor: "c".repeat(64), service, sessionId: start.sessionId }))
      .rejects.toThrow("not found");
    await expect(serviceWorker.handle({ action: "write", actor, service: service.replace("healthy", "other"), sessionId: start.sessionId, input: "ls\n" }))
      .rejects.toThrow("not found");
    await expect(serviceWorker.handle({ action: "write", actor, service, sessionId: start.sessionId, input: "a".repeat(9000) }))
      .rejects.toThrow("too large");
    shell.write("hello from container\r\n");
    const read = await serviceWorker.handle({ action: "read", actor, service, sessionId: start.sessionId }) as { output: string };
    expect(read.output).toContain("hello from container");
    expect((await serviceWorker.handle({ action: "close", actor, service, sessionId: start.sessionId }) as {closed: boolean}).closed).toBe(true);
    await expect(serviceWorker.handle({ action: "read", actor, service, sessionId: start.sessionId })).rejects.toThrow("not found");
  });
  it("rejects unauthenticated or malformed internal requests", async () => {
    const { serviceWorker } = worker();
    await expect(serviceWorker.handle({ action: "containers", actor: "<script>", service })).rejects.toThrow("identity");
    await expect(serviceWorker.handle({ action: "start", actor, service: "docker", container })).rejects.toThrow("identity");
  });
});
