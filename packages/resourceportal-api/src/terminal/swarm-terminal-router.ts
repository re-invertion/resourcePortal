import { lookup } from "node:dns/promises";
import { ContainerTerminalWorker } from "./terminal-worker";

type TerminalRequest = Record<string, unknown>;
type TerminalResponse = Record<string, unknown>;
type Agent = { address: string; base: string };
type ContainerLocation = { container: string; agent: Agent };
const idPattern = /^[a-f0-9]{12,64}$/;

/**
 * Routes an authenticated tenant terminal session to the actual Swarm node.
 * The API enforces tenant ownership and RBAC; internal node agents only accept
 * the private Worker secret on the control-plane overlay (no published port).
 * Session mapping is deliberately ephemeral; a Worker restart closes the UI
 * session rather than reattaching to an unverifiable process on another node.
 */
export class SwarmTerminalRouter {
  private readonly local = new ContainerTerminalWorker();
  private readonly sessions = new Map<string, { agent: Agent; actor: string; service: string; lastAccess: number }>();
  constructor(private readonly token: string, private readonly stack: string) {
    if (!token) throw new Error("Internal Worker terminal authentication unavailable");
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(stack)) throw new Error("Invalid Swarm stack name");
    const timer = setInterval(() => {
      for (const [id, session] of this.sessions) if (Date.now() - session.lastAccess > 5 * 60_000) this.sessions.delete(id);
    }, 30_000);
    timer.unref();
  }

  private async agents(): Promise<Agent[]> {
    const name = `tasks.${this.stack}_terminal-agent`;
    const addresses = await lookup(name, { all: true, family: 4 }).catch(() => []);
    return [...new Set(addresses.map((a) => a.address))].filter((a) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a))
      .map((address) => ({ address, base: `http://${address}:3102` }));
  }

  private async send(agent: Agent, payload: TerminalRequest): Promise<TerminalResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), payload.action === "execute" ? 18_000 : 8500);
    try {
      const response = await fetch(`${agent.base}/internal/container-terminal`, {
        method: "POST", headers: { "content-type": "application/json", "x-internal-token": this.token },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid terminal agent response");
      if (!response.ok) throw new Error(typeof (result as Record<string, unknown>).message === "string"
        ? String((result as Record<string, unknown>).message) : "Terminal node unavailable");
      return result as TerminalResponse;
    } finally { clearTimeout(timeout); }
  }

  private async locations(service: string, actor: string, agents: Agent[]): Promise<ContainerLocation[]> {
    const found = await Promise.all(agents.map(async (agent) => {
      const response = await this.send(agent, { action: "containers", service, actor });
      if (!Array.isArray(response.containers) || !response.containers.every((c) => typeof c === "string" && idPattern.test(c))) throw new Error("Invalid Swarm node container inventory");
      const candidates = response.containers as string[];
      return candidates.map((container) => ({ container, agent }));
    }));
    return found.flat();
  }

  async handle(payload: TerminalRequest): Promise<TerminalResponse> {
    const actor = payload.actor, service = payload.service, action = payload.action;
    // Always validate principal and service before network discovery.
    if (typeof actor !== "string" || !/^[a-zA-Z0-9:@._-]{1,160}$/.test(actor) || typeof service !== "string" || !/^rp_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}_[a-zA-Z0-9_]+$/.test(service)) throw new Error("Invalid terminal identity");
    const agents = await this.agents();
    if (!agents.length) {
      if (process.env.NODE_ENV === "production") throw new Error("Swarm terminal agents unavailable");
      // Supports isolated developer/test environments without a Swarm overlay.
      return await this.local.handle(payload) as TerminalResponse;
    }
    if (action === "containers" || action === "start" || action === "execute") {
      const locations = await this.locations(service, actor, agents);
      if (action === "containers") return { containers: locations.map((c) => c.container) };
      const requested = payload.container;
      if (requested !== undefined && (typeof requested !== "string" || !idPattern.test(requested))) throw new Error("Invalid container selection");
      const matches = requested ? locations.filter((c) => c.container === requested) : locations;
      if (!matches.length) throw new Error("No running task of this application is available on Swarm nodes");
      if (matches.length !== 1) throw new Error("Multiple replicas: select the target container");
      const location = matches[0];
      const result = await this.send(location.agent, { ...payload, container: location.container });
      if (action === "start") {
        if (typeof result.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(result.sessionId)) throw new Error("Terminal node returned invalid session ID");
        this.sessions.set(result.sessionId, { agent: location.agent, actor, service, lastAccess: Date.now() });
      }
      return result;
    }
    if (action === "read" || action === "write" || action === "resize" || action === "close") {
      if (typeof payload.sessionId !== "string") throw new Error("Missing terminal session");
      const session = this.sessions.get(payload.sessionId);
      if (!session || session.actor !== actor || session.service !== service) throw new Error("Terminal session not found");
      session.lastAccess = Date.now();
      const response = await this.send(session.agent, payload);
      if (action === "close" || (action === "read" && response.finished === true)) this.sessions.delete(payload.sessionId);
      return response;
    }
    throw new Error("Unsupported terminal action");
  }
}
