import { spawn } from "node:child_process";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

const servicePattern = /^rp_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}_[a-zA-Z0-9_]+$/;
const maxOutput = 65536;
const idleMs = 5 * 60_000;
type Session = { actor: string; service: string; container: string; socket: Duplex; execId: string; output: string; finished: boolean; lastAccess: number };

// Internal-only terminal broker: the public API resolves tenant ownership and RBAC.
export class ContainerTerminalWorker {
  private readonly sessions = new Map<string, Session>();
  constructor() {
    const timer = setInterval(() => {
      for (const [id, session] of this.sessions) if (Date.now() - session.lastAccess > idleMs) this.close(id, session);
    }, 30_000);
    timer.unref();
  }

  private async engine(path: string, method: "GET" | "POST", body?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const req = request({ socketPath: "/var/run/docker.sock", path: `/v1.43${path}`, method,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 7000 }, (res) => {
        const buffers: Buffer[] = [];
        let length = 0;
        res.on("data", (chunk: Buffer) => { length += chunk.length; if (length < 65536) buffers.push(chunk); else req.destroy(new Error("Docker response too large")); });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error("Container runtime unavailable"));
          try { resolve(Buffer.concat(buffers).length ? JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown> : {}); }
          catch { reject(new Error("Unexpected container runtime response")); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Container runtime timeout")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  private async shell(container: string): Promise<{ socket: Duplex; execId: string }> {
    const created = await this.engine(`/containers/${container}/exec`, "POST", {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Cmd: ["/bin/sh", "-i"],
    });
    if (typeof created.Id !== "string" || !/^[a-f0-9]{64}$/.test(created.Id)) throw new Error("Failed to allocate container shell");
    const execId = created.Id;
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: true });
      const req = request({ socketPath: "/var/run/docker.sock", path: `/v1.43/exec/${execId}/start`, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "Upgrade", upgrade: "tcp" }, timeout: 7000 });
      req.on("upgrade", (_res, stream, head) => {
        stream.setTimeout(0);
        if (head.length) stream.unshift(head);
        resolve(stream);
      });
      req.on("response", (res) => { res.resume(); reject(new Error("Container runtime does not support an interactive terminal upgrade")); });
      req.on("timeout", () => req.destroy(new Error("Container shell timeout")));
      req.on("error", reject);
      req.end(body);
    });
    return { socket, execId };
  }

  private async docker(args: string[], timeoutMs = 7000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let finished = false;
      const complete = (err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(output);
      };
      const timer = setTimeout(() => { child.kill("SIGKILL"); complete(new Error("Container command timed out")); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-maxOutput); });
      child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-maxOutput); });
      child.on("error", (error) => complete(error));
      child.on("close", (code) => complete(code === 0 ? undefined : new Error("Container operation unavailable")));
    });
  }

  private async containers(service: string): Promise<string[]> {
    if (!servicePattern.test(service)) throw new Error("Invalid service");
    const output = await this.docker(["ps", "--filter", `label=com.docker.swarm.service.name=${service}`, "--format", "{{.ID}}"]).catch(() => "");
    return output.split("\n").map((item) => item.trim()).filter((item) => /^[a-f0-9]{12,64}$/.test(item));
  }

  private async select(service: string, requested?: unknown): Promise<string> {
    const candidates = await this.containers(service);
    if (!candidates.length) throw new Error("No running application container on this worker node");
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string" || !candidates.includes(requested)) throw new Error("Requested container is not a running task of this application");
      return requested;
    }
    if (candidates.length > 1) throw new Error("Multiple replicas: select a container explicitly");
    return candidates[0];
  }

  private session(id: unknown, actor: string, service: string): Session {
    const session = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!session || session.actor !== actor || session.service !== service) throw new Error("Terminal session not found");
    session.lastAccess = Date.now();
    return session;
  }

  private close(id: string, session: Session) {
    session.socket.destroy();
    this.sessions.delete(id);
  }

  async handle(payload: Record<string, unknown>): Promise<unknown> {
    const { action, actor, service } = payload;
    if (typeof actor !== "string" || !/^[a-zA-Z0-9:@._-]{1,160}$/.test(actor) || typeof service !== "string" || !servicePattern.test(service)) throw new Error("Invalid terminal identity");
    if (action === "containers") return { containers: await this.containers(service) };
    if (action === "start") {
      if (this.sessions.size >= 16) throw new Error("Terminal session limit reached");
      const container = await this.select(service, payload.container);
      const { socket, execId } = await this.shell(container);
      const id = randomUUID();
      const session: Session = { actor, service, container, socket, execId, output: "", finished: false, lastAccess: Date.now() };
      this.sessions.set(id, session);
      socket.on("data", (chunk: Buffer) => { session.output = (session.output + chunk.toString()).slice(-maxOutput); });
      socket.on("error", () => { session.finished = true; });
      socket.on("close", () => { session.finished = true; });
      return { sessionId: id, container, idleTimeoutSeconds: idleMs / 1000 };
    }
    if (action === "execute") {
      if (typeof payload.command !== "string" || !payload.command.trim() || Buffer.byteLength(payload.command) > 4096) throw new Error("Invalid command");
      const container = await this.select(service, payload.container);
      const output = await this.docker(["exec", "-i", container, "/bin/sh", "-lc", payload.command], 15_000);
      return { container, output };
    }
    const id = payload.sessionId;
    const session = this.session(id, actor, service);
    if (action === "read") {
      const output = session.output;
      session.output = "";
      let exitCode: number | null = null;
      if (session.finished) {
        const inspect = await this.engine(`/exec/${session.execId}/json`, "GET").catch(() => null);
        exitCode = inspect && typeof inspect.ExitCode === "number" ? inspect.ExitCode : null;
        this.close(id as string, session);
      }
      return { output, finished: session.finished, container: session.container, exitCode };
    }
    if (action === "write") {
      if (session.finished) throw new Error("Shell has exited");
      if (typeof payload.input !== "string" || Buffer.byteLength(payload.input) > 8192) throw new Error("Terminal input too large");
      session.socket.write(payload.input);
      return { accepted: true };
    }
    if (action === "resize") {
      const cols = payload.cols, rows = payload.rows;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 20 || Number(cols) > 300 || Number(rows) < 5 || Number(rows) > 120) throw new Error("Invalid terminal dimensions");
      await this.engine(`/exec/${session.execId}/resize?w=${cols}&h=${rows}`, "POST");
      return { resized: true };
    }
    if (action === "close") { this.close(id as string, session); return { closed: true }; }
    throw new Error("Unsupported terminal action");
  }
}
