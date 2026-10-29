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

  it("reports an explicit exit status rather than treating empty execution output as success (#363)", async () => {
    const { serviceWorker } = worker();
    Object.defineProperty(serviceWorker, "docker", { value: vi.fn().mockResolvedValue({ stdout: "", stderr: "failure", exitCode: 7, timedOut: false, truncated: false, status: "failed" }) });
    const result = await serviceWorker.handle({ action: "execute", actor, service, container, command: "exit 7" });
    expect(result).toMatchObject({ stdout: "", stderr: "failure", exitCode: 7, status: "failed" });
  });

  it.each([
    { command: "printf 'first\\nsecond\\n'", stdout: "first\nsecond\n", stderr: "", exitCode: 0, status: "completed", timedOut: false, truncated: false },
    { command: "python3 -c 'print(123)'", stdout: "123\n", stderr: "", exitCode: 0, status: "completed", timedOut: false, truncated: false },
    { command: "echo failure >&2; exit 9", stdout: "", stderr: "failure\n", exitCode: 9, status: "failed", timedOut: false, truncated: false },
    { command: "sleep 999", stdout: "", stderr: "", exitCode: 124, status: "timed_out", timedOut: true, truncated: false },
    { command: "printf test", stdout: "", stderr: "Docker transport error", exitCode: null, status: "transport_error", timedOut: false, truncated: false },
    { command: "head -c 100000 /dev/zero", stdout: "a".repeat(65536), stderr: "", exitCode: 0, status: "output_truncated", timedOut: false, truncated: true },
  ])("propagates an unambiguous exec outcome for $command (#363)", async (expected) => {
    const { serviceWorker } = worker();
    const docker = vi.fn().mockResolvedValue(expected);
    Object.defineProperty(serviceWorker, "docker", { value: docker });
    const result = await serviceWorker.handle({ action: "execute", actor, service, container, command: expected.command }) as Record<string, unknown>;
    expect(result).toMatchObject({ stdout: expected.stdout, stderr: expected.stderr, exitCode: expected.exitCode,
      status: expected.status, timedOut: expected.timedOut, truncated: expected.truncated });
    expect(docker).toHaveBeenCalledWith(["exec", "-i", container, "/bin/sh", "-lc", expected.command], 15000);
  });

  it("reports a retriable read cursor and preserves output across repeated reads (#364)", async () => {
    const { serviceWorker, shell } = worker();
    const opened = await serviceWorker.handle({ action: "start", actor, service, container }) as { sessionId: string };
    shell.write("one\ntwo\n");
    const payload = { action: "read", actor, service, sessionId: opened.sessionId, cursor: 0 };
    const first = await serviceWorker.handle(payload) as { output: string; nextCursor: number; state: string };
    const replay = await serviceWorker.handle(payload) as { output: string; nextCursor: number; state: string };
    expect(first.output).toBe("one\ntwo\n");
    expect(replay.output).toBe(first.output);
    expect(first.nextCursor).toBe(replay.nextCursor);
    expect(first.state).toBe("data");
    await serviceWorker.handle({ action: "close", actor, service, sessionId: opened.sessionId });
  });

  it("distinguishes idle reads, EOF and failures, with explicit output overrun (#364)", async () => {
    const { serviceWorker, shell } = worker();
    const opened = await serviceWorker.handle({ action: "start", actor, service, container }) as { sessionId: string };
    shell.write(Buffer.alloc(65540, 65));
    await expect(serviceWorker.handle({ action: "read", actor, service, sessionId: opened.sessionId, cursor: 0 }))
      .rejects.toThrow("buffer overrun");
    const buffered = await serviceWorker.handle({ action: "read", actor, service, sessionId: opened.sessionId, cursor: 4 }) as { output: string; nextCursor: number; state: string };
    expect(buffered.output).toHaveLength(65536);
    expect(buffered.nextCursor).toBe(65540);
    expect(buffered.state).toBe("data");
    shell.end();
    const eof = await serviceWorker.handle({ action: "read", actor, service, sessionId: opened.sessionId, cursor: 65540 }) as { state: string; finished: boolean };
    expect(eof).toMatchObject({ state: "eof", finished: true });
    await serviceWorker.handle({ action: "close", actor, service, sessionId: opened.sessionId });
  });

  it("rejects a cursor overrun that occurs while waiting for shell output (#364)", async () => {
    const { serviceWorker, shell } = worker();
    const opened = await serviceWorker.handle({ action: "start", actor, service, container }) as { sessionId: string };
    const pending = serviceWorker.handle({ action: "read", actor, service, sessionId: opened.sessionId, cursor: 0 });
    shell.write(Buffer.alloc(65540, 65));
    await expect(pending).rejects.toThrow("buffer overrun");
    await serviceWorker.handle({ action: "close", actor, service, sessionId: opened.sessionId });
  });

  it("rejects unauthenticated or malformed internal requests", async () => {
    const { serviceWorker } = worker();
    await expect(serviceWorker.handle({ action: "containers", actor: "<script>", service })).rejects.toThrow("identity");
    await expect(serviceWorker.handle({ action: "start", actor, service: "docker", container })).rejects.toThrow("identity");
  });
});
