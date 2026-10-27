import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiRequest } from "../../api/client";
import { Button, Callout, StatusBadge } from "../../components/design-system";

type Session = { sessionId: string; container: string; idleTimeoutSeconds: number };
type SessionOutput = { output: string; finished: boolean; container: string; exitCode?: number | null };

export function ApplicationTerminal({ appRoot, running }: { appRoot: string; running: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingInput = useRef("");
  const writing = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState("");
  const [status, setStatus] = useState("Disconnected");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const terminalCall = useCallback(<T,>(action: string, body: Record<string, unknown> = {}) =>
    apiRequest<T>(`${appRoot}/terminal/${action}`, { method: "POST", body }), [appRoot]);

  const refreshContainers = useCallback(async () => {
    try {
      const found = await terminalCall<{ containers: string[] }>("containers");
      setContainers(found.containers);
      setContainer((previous) => found.containers.includes(previous) ? previous : found.containers[0] ?? "");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to discover running containers"); }
  }, [terminalCall]);

  useEffect(() => {
    if (running) void refreshContainers();
  }, [running, refreshContainers]);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let inputTimer: number | undefined;
    let dataSubscription: { dispose(): void } | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed || !hostRef.current) return;
      const term = new xterm.Terminal({
        cursorBlink: true, convertEol: true, scrollback: 1500,
        fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#172033", foreground: "#e2e8f0", cursor: "#f8fafc", selectionBackground: "#315b86" },
      });
      const fit = new addon.FitAddon();
      term.loadAddon(fit); term.open(hostRef.current);
      termRef.current = term; fitRef.current = fit;
      fit.fit();
      term.writeln("ResourcePortal application shell");
      term.writeln("Connect to a running container to start a session.\r\n");
      dataSubscription = term.onData((input) => { if (sessionIdRef.current) pendingInput.current += input; });
      inputTimer = window.setInterval(() => {
        const sessionId = sessionIdRef.current;
        if (!sessionId || writing.current || !pendingInput.current) return;
        const input = pendingInput.current.slice(0, 4096);
        pendingInput.current = pendingInput.current.slice(input.length);
        writing.current = true;
        void terminalCall("write", { sessionId, input }).catch(() => {
          if (sessionIdRef.current === sessionId) { setError("Terminal input was not delivered. Reconnect the session."); setStatus("Connection lost"); }
        }).finally(() => { writing.current = false; });
      }, 45);
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        fit.fit();
        const sessionId = sessionIdRef.current;
        if (sessionId) void terminalCall("resize", { sessionId, rows: term.rows, cols: term.cols }).catch(() => undefined);
      });
      resizeObserver.observe(hostRef.current);
    });
    return () => {
      disposed = true;
      if (inputTimer) window.clearInterval(inputTimer);
      resizeObserver?.disconnect(); dataSubscription?.dispose();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void terminalCall("close", { sessionId }).catch(() => undefined);
      termRef.current?.dispose(); termRef.current = null; fitRef.current = null;
    };
  }, [terminalCall]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let pending = false;
    const poll = () => {
      if (pending || !active) return;
      pending = true;
      void terminalCall<SessionOutput>("read", { sessionId: session.sessionId })
        .then((result) => {
          if (!active) return;
          if (result.output) termRef.current?.write(result.output);
          if (result.finished) {
            termRef.current?.writeln(`\r\n[Shell process exited${typeof result.exitCode === "number" ? ` with code ${result.exitCode}` : ""}]`);
            sessionIdRef.current = null; setSession(null); setStatus("Exited");
          }
        })
        .catch((cause) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : "Shell disconnected");
          sessionIdRef.current = null; setSession(null); setStatus("Connection lost");
        })
        .finally(() => { pending = false; });
    };
    poll();
    const timer = window.setInterval(poll, 320);
    return () => { active = false; window.clearInterval(timer); };
  }, [session, terminalCall]);

  async function connect() {
    setBusy(true); setError(""); setStatus("Connecting");
    try {
      const result = await terminalCall<Session>("start", { container });
      sessionIdRef.current = result.sessionId;
      setSession(result);
      setStatus("Connected");
      termRef.current?.clear();
      termRef.current?.writeln(`Connected to ${result.container}. Use Ctrl+C to interrupt the foreground process.\r\n`);
      termRef.current?.focus();
      const term = termRef.current;
      if (term) void terminalCall("resize", { sessionId: result.sessionId, rows: term.rows, cols: term.cols }).catch(() => undefined);
    } catch (cause) {
      setStatus("Disconnected"); setError(cause instanceof Error ? cause.message : "Unable to open container shell");
    } finally { setBusy(false); }
  }

  async function disconnect() {
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    setSession(null); setStatus("Disconnected"); pendingInput.current = "";
    if (id) try { await terminalCall("close", { sessionId: id }); } catch { /* idle timeout also closes worker session */ }
    termRef.current?.writeln("\r\n[Disconnected]");
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-base font-semibold text-[#172033]">Container terminal</h3><p className="mt-1 text-xs text-[#718096]">Interactive shell in the selected running Swarm task. Requires application edit, deployment read and secret read permissions.</p></div>
      <StatusBadge tone={session ? "success" : "warning"}>{status}</StatusBadge>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium text-[#526070]">Running container
        <select aria-label="Running container" className="mt-1 block h-10 w-full rounded-lg border border-[#B9C5D6] bg-white px-3 text-sm text-[#172033]" value={container} disabled={Boolean(session) || busy} onChange={(event) => setContainer(event.target.value)}>
          {containers.length ? containers.map((id) => <option key={id} value={id}>{id}</option>) : <option value="">No running tasks</option>}
        </select>
      </label>
      <Button size="sm" onClick={() => void refreshContainers()} disabled={busy || Boolean(session)}>Refresh tasks</Button>
      {session ? <Button size="sm" variant="secondary" onClick={() => void disconnect()}>Disconnect</Button> : <Button size="sm" variant="primary" disabled={!running || !container || busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</Button>}
    </div>
    {error ? <Callout tone="warning" title="Terminal unavailable">{error}</Callout> : null}
    {!running ? <Callout tone="warning" title="Application is not running">Start and deploy the application before opening its shell.</Callout> : null}
    {running && !containers.length ? <p className="text-xs text-[#718096]">No running Swarm task is currently available for this application.</p> : null}
    <div className="rounded-lg border border-[#344258] bg-[#172033] p-3">
      <div aria-label="Interactive container terminal" ref={hostRef} className="h-[430px] w-full overflow-hidden" />
    </div>
    <p className="text-xs text-[#718096]">Shell input and output are not stored in the RP audit log. Session metadata is audited; idle shells expire after five minutes.</p>
  </div>;
}
