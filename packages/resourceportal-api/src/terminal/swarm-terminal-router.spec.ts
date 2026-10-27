import { describe, expect, it, vi } from "vitest";
import { SwarmTerminalRouter } from "./swarm-terminal-router";

const actor = "a".repeat(64);
const service = "rp_22222222_2222_4222_8222_222222222222_worker_shell";
const container = "b".repeat(12);
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agent = { address: "10.0.0.5", base: "http://10.0.0.5:3102" };

describe("tenant terminal Swarm remote routing", () => {
  function router() {
    const dispatcher = new SwarmTerminalRouter("internal-token", "rp-test");
    const send = vi.fn(async (_agent: unknown, payload: Record<string, unknown>) => {
      if (payload.action === "containers") return { containers: [container] };
      if (payload.action === "start") return { sessionId, container };
      if (payload.action === "read") return { output: "test output", finished: false };
      return { accepted: true };
    });
    Object.defineProperty(dispatcher, "agents", { value: vi.fn().mockResolvedValue([agent]) });
    Object.defineProperty(dispatcher, "send", { value: send });
    return { dispatcher, send };
  }

  it("discovers the owning Swarm node and pins the session to it", async () => {
    const { dispatcher, send } = router();
    expect(await dispatcher.handle({ action: "containers", actor, service })).toEqual({ containers: [container] });
    const started = await dispatcher.handle({ action: "start", actor, service, container });
    expect(started).toMatchObject({ sessionId, container });
    expect(send).toHaveBeenCalledWith(agent, { action: "start", actor, service, container });
    const read = await dispatcher.handle({ action: "read", actor, service, sessionId });
    expect(read).toMatchObject({ output: "test output" });
    expect(send).toHaveBeenCalledWith(agent, { action: "read", actor, service, sessionId });
    await dispatcher.handle({ action: "close", actor, service, sessionId });
    await expect(dispatcher.handle({ action: "read", actor, service, sessionId })).rejects.toThrow("not found");
  });
  it("rejects stolen sessions, incorrect services and containers before remote execution", async () => {
    const { dispatcher, send } = router();
    await expect(dispatcher.handle({ action: "execute", actor, service, container: "f".repeat(12), command: "id" })).rejects.toThrow("No running task");
    const started = await dispatcher.handle({ action: "start", actor, service, container });
    expect(started.sessionId).toBe(sessionId);
    await expect(dispatcher.handle({ action: "write", actor: "d".repeat(64), service, sessionId, input: "id\n" })).rejects.toThrow("not found");
    await expect(dispatcher.handle({ action: "read", actor, service: service.replace("worker_shell", "other"), sessionId })).rejects.toThrow("not found");
    expect(send.mock.calls.filter((call) => call[1].action === "write")).toHaveLength(0);
  });
  it("does not delegate requests with malformed service names to remote nodes", async () => {
    const { dispatcher, send } = router();
    await expect(dispatcher.handle({ action: "containers", actor, service: "host" })).rejects.toThrow("Invalid terminal identity");
    expect(send).not.toHaveBeenCalled();
  });
});
