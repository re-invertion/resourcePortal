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
    Object.defineProperty(serviceWorker, "shell", { configurable: true, value: vi.fn().mockResolvedValue({ socket: shell, execId: "c".repeat(64) }) });
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
  it("atomically caps concurrent shell starts and frees closed capacity", async () => {
    const { serviceWorker } = worker();
    let completeFirst: ((value: { socket: PassThrough; execId: string }) => void) | undefined;
    let callCount = 0;
    const shell = vi.fn(() => {
      callCount++;
      if (callCount === 1) return new Promise<{ socket: PassThrough; execId: string }>((resolve) => { completeFirst = resolve; });
      return Promise.resolve({ socket: new PassThrough(), execId: "c".repeat(64) });
    });
    Object.defineProperty(serviceWorker, "shell", { value: shell });
    const attempts = Array.from({ length: 32 }, () => serviceWorker.handle({ action: "start", actor, service, container }));
    const results = await Promise.allSettled(attempts.slice(1));
    completeFirst?.({ socket: new PassThrough(), execId: "c".repeat(64) });
    const initial = await attempts[0];
    const success = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(initial).toHaveProperty("sessionId");
    expect(success).toHaveLength(15);
    expect(rejected).toHaveLength(16);
    expect(shell).toHaveBeenCalledTimes(16);
    expect(rejected.every((result) => result.status === "rejected" && String(result.reason).includes("session limit"))).toBe(true);
    await serviceWorker.handle({ action: "close", actor, service, sessionId: (initial as { sessionId: string }).sessionId });
    await expect(serviceWorker.handle({ action: "start", actor, service, container })).resolves.toHaveProperty("sessionId");
  });

  it("releases a reservation when Docker shell allocation fails", async () => {
    const { serviceWorker } = worker();
    let first = true;
    Object.defineProperty(serviceWorker, "shell", { value: vi.fn(() => {
      if (first) { first = false; return Promise.reject(new Error("Docker unavailable")); }
      return Promise.resolve({ socket: new PassThrough(), execId: "c".repeat(64) });
    }) });
    await expect(serviceWorker.handle({ action: "start", actor, service, container })).rejects.toThrow("Docker unavailable");
    await expect(serviceWorker.handle({ action: "start", actor, service, container })).resolves.toHaveProperty("sessionId");
  });

  it("long-polls until output arrives instead of requiring rapid empty reads", async () => {
    const { serviceWorker, shell } = worker();
    const opened = await serviceWorker.handle({ action: "start", actor, service, container }) as {sessionId: string};
    const readPromise = serviceWorker.handle({ action: "read", actor, service, sessionId: opened.sessionId });
    queueMicrotask(() => shell.write("prompt> "));
    const result = await readPromise as {output: string};
    expect(result.output).toContain("prompt> ");
    await serviceWorker.handle({ action: "close", actor, service, sessionId: opened.sessionId });
  });

  it("rejects unauthenticated or malformed internal requests", async () => {
    const { serviceWorker } = worker();
    await expect(serviceWorker.handle({ action: "containers", actor: "<script>", service })).rejects.toThrow("identity");
    await expect(serviceWorker.handle({ action: "start", actor, service: "docker", container })).rejects.toThrow("identity");
  });
});
