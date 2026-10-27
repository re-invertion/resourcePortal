/** Real Swarm PTY + worker broker security smoke. Called from swarm-integration workflow. */
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SwarmTerminalRouter } from "../src/terminal/swarm-terminal-router";
import { startTerminalAgent } from "../src/terminal/terminal-agent.runner";

const service = "rp_00000000_0000_4000_8000_000000000001_terminal_smoke";
const actor = "ci-smoke-test";
function docker(...args: string[]) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function main() {
  // Cleanup pre-existing smoke only; never touch unrelated tenant services.
  if (spawnSync("docker", ["service", "inspect", service], { encoding: "utf8" }).status === 0) {
    throw new Error(`Refusing to overwrite existing smoke service: ${service}`);
  }
  docker("service", "create", "--detach=true", "--name", service, "--replicas", "1", "alpine:3.20", "sleep", "180");
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
    await broker.handle({ action: "close", actor, service, sessionId: started.sessionId });
    await expectFailure(() => broker.handle({ action: "read", actor, service, sessionId: started.sessionId }), "closed session rejected");
    const oneShot = await broker.handle({ action: "execute", actor, service, container, command: "printf RP_SINGLE_COMMAND_OK" }) as { output: string };
    if (!oneShot.output.includes("RP_SINGLE_COMMAND_OK")) throw new Error("Bounded one-shot command did not return output");
    console.log("Real Docker Swarm interactive terminal smoke passed: private node HTTP, PTY, resize, isolation, close and one-shot command");
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
