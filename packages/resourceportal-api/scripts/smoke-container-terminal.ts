/** Real Swarm PTY + worker broker security smoke. Called from swarm-integration workflow. */
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SwarmTerminalRouter } from "../src/terminal/swarm-terminal-router";
import { startTerminalAgent } from "../src/terminal/terminal-agent.runner";

const service = "rp_00000000_0000_4000_8000_000000000001_terminal_smoke";
const actor = "ci-smoke-test";
function docker(...args: string[]) {
  // A force update legitimately waits for a replacement task and must remain bounded.
  const timeout = args[0] === "service" && args[1] === "update" ? 60_000 : 15_000;
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function main() {
  // Cleanup pre-existing smoke only; never touch unrelated tenant services.
  if (spawnSync("docker", ["service", "inspect", service], { encoding: "utf8" }).status === 0) {
    throw new Error(`Refusing to overwrite existing smoke service: ${service}`);
  }
  docker("service", "create", "--detach=true", "--name", service, "--replicas", "1", "python:3.12-alpine", "sleep", "240");
  try {
    // Exercise the real HTTP transport between Worker router and node agent,
    // not just a local Docker CLI shell. The CI Swarm is single-node.
    const secret = "terminal-real-swarm-ci-long-secret";
    const agentServer = startTerminalAgent(0, secret);
    await new Promise<void>((resolve) => agentServer.once("listening", resolve));
    try {
      const address = agentServer.address();
      if (!address || typeof address === "string") throw new Error("Terminal agent failed to listen");
      const broker = new SwarmTerminalRouter(secret, "ci-stack");
      Object.defineProperty(broker, "agents", { value: () => Promise.resolve([{ address: "127.0.0.1", base: `http://127.0.0.1:${address.port}` }]) });
    let containers: string[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await broker.handle({ action: "containers", actor, service }) as { containers: string[] };
      containers = result.containers;
      if (containers.length) break;
      await delay(1000);
    }
    if (containers.length !== 1) throw new Error("Swarm smoke service did not start a single local container");
    const container = containers[0];
    await expectFailure(() => broker.handle({ action: "start", actor, service, container: "f".repeat(12) }), "foreign container rejected");
    const started = await broker.handle({ action: "start", actor, service, container }) as { sessionId: string };
    if (!started.sessionId) throw new Error("Docker Engine PTY upgrade did not return a session");
    await expectFailure(() => broker.handle({ action: "read", actor: "other", service, sessionId: started.sessionId }), "cross-actor shell read rejected");
    await broker.handle({ action: "resize", actor, service, sessionId: started.sessionId, rows: 24, cols: 80 });
    await broker.handle({ action: "write", actor, service, sessionId: started.sessionId, input: "printf 'RP_%s' 'TERMINAL_SMOKE_OK'\n" });
    let output = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      const read = await broker.handle({ action: "read", actor, service, sessionId: started.sessionId }) as { output: string };
      output += read.output;
      if (output.includes("RP_TERMINAL_SMOKE_OK")) break;
      await delay(200);
    }
    if (!output.includes("RP_TERMINAL_SMOKE_OK")) throw new Error("Interactive PTY did not return command output");
    const replay = await broker.handle({ action: "read", actor, service, sessionId: started.sessionId, cursor: 0 }) as { output: string; nextCursor: number; state: string };
    if (!replay.output.includes("RP_TERMINAL_SMOKE_OK") || replay.nextCursor <= 0 || replay.state !== "data") {
      throw new Error("Interactive Swarm terminal cursor replay lost output");
    }
    const idle = await broker.handle({ action: "read", actor, service, sessionId: started.sessionId, cursor: replay.nextCursor }) as { nextCursor: number; state: string };
    if (idle.nextCursor < replay.nextCursor || !["idle", "data"].includes(idle.state)) {
      throw new Error("Interactive Swarm terminal returned an invalid cursor while idle");
    }
    await broker.handle({ action: "close", actor, service, sessionId: started.sessionId });
    await expectFailure(() => broker.handle({ action: "read", actor, service, sessionId: started.sessionId }), "closed session rejected");
    const oneShot = await broker.handle({ action: "execute", actor, service, container, command: "printf RP_SINGLE_COMMAND_OK" }) as { output: string };
    if (!oneShot.output.includes("RP_SINGLE_COMMAND_OK")) throw new Error("Bounded one-shot command did not return output");
    const cases = [
      { command: "printf 'short\nsecond\n'", stdout: "short\nsecond\n", exitCode: 0, status: "completed" },
      { command: "python3 -c 'print(123)'", stdout: "123\n", exitCode: 0, status: "completed" },
      { command: "echo expected-error >&2; exit 7", stderr: "expected-error\n", exitCode: 7, status: "failed" },
    ];
    for (const spec of cases) {
      const result = await broker.handle({ action: "execute", actor, service, container, command: spec.command }) as {
        stdout: string; stderr: string; exitCode: number; status: string; truncated: boolean;
      };
      if (result.status !== spec.status || result.exitCode !== spec.exitCode || result.truncated ||
          (spec.stdout !== undefined && result.stdout !== spec.stdout) ||
          (spec.stderr !== undefined && result.stderr !== spec.stderr)) {
        throw new Error(`Swarm exec reported an incorrect outcome for ${spec.command}: ${JSON.stringify(result)}`);
      }
    }
    const truncated = await broker.handle({ action: "execute", actor, service, container,
      command: "head -c 70000 /dev/zero | tr '\\000' x" }) as { status: string; truncated: boolean; stdout: string; exitCode: number };
    if (truncated.status !== "output_truncated" || !truncated.truncated || truncated.exitCode !== 0 || truncated.stdout.length !== 65536) {
      throw new Error("Swarm exec silently lost output without reporting truncation");
    }
    const timedOut = await broker.handle({ action: "execute", actor, service, container, command: "sleep 30" }) as {
      status: string; timedOut: boolean; exitCode: number;
    };
    if (timedOut.status !== "timed_out" || !timedOut.timedOut || timedOut.exitCode !== 124) {
      throw new Error("Swarm exec did not report its execution deadline");
    }

    // A real Swarm force restart must converge and replace its task, never merely enqueue.
    const beforeRestart = docker("service", "ps", service, "--filter", "desired-state=running", "--format", "{{.ID}}");
    docker("service", "update", "--force", "--detach=false", service);
    const afterRestart = docker("service", "ps", service, "--filter", "desired-state=running", "--format", "{{.ID}}");
    if (!beforeRestart || !afterRestart || beforeRestart === afterRestart) {
      throw new Error("SingleApp force restart did not converge to a replacement Swarm task");
    }
    console.log("Real Docker Swarm exec outcomes, PTY, cursor, and force-restart convergence passed");
    } finally { await new Promise<void>((resolve) => agentServer.close(() => resolve())); }
  } finally {
    docker("service", "rm", service);
  }
}

async function expectFailure(action: () => Promise<unknown>, reason: string) {
  try { await action(); } catch { return; }
  throw new Error(`Security check unexpectedly allowed: ${reason}`);
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
