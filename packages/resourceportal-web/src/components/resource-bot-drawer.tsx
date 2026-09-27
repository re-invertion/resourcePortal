import { useMemo, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import { Button, HelpIcon, XIcon } from "./design-system";
import { useApi } from "../hooks/use-api";

type ResourceBotStatus = {
  available?: boolean;
  tenantEnabled?: boolean;
  platformAvailable?: boolean;
  priceAvailable?: boolean;
  billingActive?: boolean;
  reason?: string | null;
  generationModel?: string;
};

type ResourceBotSource = {
  chunkId: string;
  sectionId: string;
  title: string;
  href: string;
};

type ResourceBotResponse = {
  requestId: string;
  answer: string;
  supportedByHelp: boolean;
  sources: ResourceBotSource[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    embeddingInputTokens: number;
    totalTokens: number;
    chargedCredits: string;
  };
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ResourceBotSource[];
  usage?: ResourceBotResponse["usage"];
};

function reasonText(reason?: string | null) {
  switch (reason) {
    case "ResourceBotDisabled":
      return "ResourceBot is disabled in Tenant Settings.";
    case "ResourceBotPlatformNotConfigured":
      return "ResourceBot is not currently available on this ResourcePortal platform.";
    case "ResourceBotPriceUnavailable":
      return "No active tenant AI tariff is configured for the selected model.";
    case "ResourceBotBillingSuspended":
      return "ResourceBot is unavailable while tenant billing is suspended.";
    default:
      return "ResourceBot is temporarily unavailable.";
  }
}

export function ResourceBotDrawer({ tenantId }: { tenantId: string }) {
  const root = "/api/tenants/" + encodeURIComponent(tenantId) + "/resource-bot";
  const status = useApi<ResourceBotStatus>(root + "/status");
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const history = useMemo(
    () =>
      messages
        .slice(-6)
        .map((message) => ({ role: message.role, content: message.content })),
    [messages],
  );

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = question.trim();
    if (!value || sending || status.data?.available !== true) return;

    const userMessage: ChatMessage = {
      id: "user-" + Date.now(),
      role: "user",
      content: value,
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setSending(true);
    setError("");

    try {
      const response = await apiRequest<ResourceBotResponse>(root + "/messages", {
        method: "POST",
        body: {
          question: value,
          history,
        },
      });
      setMessages((current) => [
        ...current,
        {
          id: "assistant-" + response.requestId,
          role: "assistant",
          content: response.answer,
          sources: response.sources,
          usage: response.usage,
        },
      ]);
      void status.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ResourceBot could not answer this question.");
    } finally {
      setSending(false);
    }
  }

  return <>
    <button
      type="button"
      aria-label="Open ResourceBot"
      title="ResourceBot"
      onClick={() => setOpen(true)}
      className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full border border-[#BFD1EA] bg-[#1769E0] px-4 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(23,105,224,.28)] transition hover:bg-[#0F5FCF]"
    >
      <HelpIcon size={18} />
      <span className="hidden sm:inline">ResourceBot</span>
    </button>

    {open ? <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        aria-label="Close ResourceBot backdrop"
        className="absolute inset-0 bg-[#0E1A2B]/25"
        onClick={() => setOpen(false)}
      />
      <aside
        aria-label="ResourceBot"
        className="absolute bottom-0 right-0 top-0 flex w-full max-w-[440px] flex-col border-l border-[#D7E0EC] bg-white shadow-[-14px_0_40px_rgba(15,23,42,.16)] sm:top-[58px]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E1E7F0] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><HelpIcon size={18}/></span>
            <div className="min-w-0">
              <h2 className="font-semibold text-[#172033]">ResourceBot</h2>
              <p className="mt-0.5 text-xs text-[#718096]">Answers from ResourcePortal Help only</p>
            </div>
          </div>
          <button type="button" aria-label="Close ResourceBot" onClick={() => setOpen(false)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#526070] hover:bg-[#EEF3F9]"><XIcon size={17}/></button>
        </div>

        <div className="border-b border-[#E1E7F0] bg-[#F8FAFD] px-5 py-3 text-xs leading-5 text-[#5B6678]">
          ResourceBot does not inspect live tenant resources and cannot perform operations. Answers link to the Help sections used as sources.
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {status.loading ? <p className="text-sm text-[#718096]">Checking ResourceBot availability…</p> : status.error ? (
            <div className="rounded-lg border border-[#F2C7C7] bg-[#FFF6F6] p-3 text-sm text-[#9B2C2C]">ResourceBot status could not be loaded.</div>
          ) : status.data?.available !== true ? (
            <div className="rounded-lg border border-[#E9D9A7] bg-[#FFF9E8] p-3 text-sm text-[#725B19]">
              <strong className="block">ResourceBot unavailable</strong>
              <span className="mt-1 block text-xs leading-5">{reasonText(status.data?.reason)}</span>
            </div>
          ) : null}

          {messages.length === 0 ? <div className="rounded-xl border border-[#E1E7F0] bg-[#F8FAFD] p-4">
            <strong className="text-sm text-[#172033]">Ask about ResourcePortal</strong>
            <p className="mt-1 text-xs leading-5 text-[#718096]">For example: creating an application, domains, persistent storage, private networking, credentials, billing or deployment operations.</p>
          </div> : messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "ml-8" : "mr-3"}>
              <div className={message.role === "user"
                ? "rounded-xl bg-[#1769E0] px-4 py-3 text-sm leading-6 text-white"
                : "rounded-xl border border-[#DDE5F0] bg-white px-4 py-3 text-sm leading-6 text-[#263449]"}>
                {message.content}
              </div>
              {message.role === "assistant" && message.sources?.length ? <div className="mt-2 flex flex-wrap gap-2">
                {message.sources.map((source) => <a key={source.chunkId} href={source.href} className="rounded-full border border-[#C9D8EB] bg-[#F7FAFE] px-2.5 py-1 text-[11px] font-medium text-[#0F56A7] hover:bg-[#EAF3FF]">{source.title}</a>)}
              </div> : null}
              {message.role === "assistant" && message.usage ? <p className="mt-1.5 text-[10px] text-[#8A96A8]">
                {message.usage.totalTokens.toLocaleString()} tokens · {message.usage.chargedCredits} credits
              </p> : null}
            </div>
          ))}

          {sending ? <div className="mr-3 rounded-xl border border-[#DDE5F0] bg-white px-4 py-3 text-sm text-[#718096]">ResourceBot is checking Help…</div> : null}
          {error ? <div className="rounded-lg border border-[#F2C7C7] bg-[#FFF6F6] p-3 text-sm text-[#9B2C2C]">{error}</div> : null}
        </div>

        <form className="border-t border-[#E1E7F0] bg-white p-4" onSubmit={(event) => void send(event)}>
          <label className="sr-only" htmlFor="resourcebot-question">Ask ResourceBot</label>
          <textarea
            id="resourcebot-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={sending || status.data?.available !== true}
            maxLength={4000}
            rows={3}
            placeholder={status.data?.available ? "Ask a question about ResourcePortal…" : "ResourceBot is unavailable"}
            className="w-full resize-none rounded-lg border border-[#B9C5D6] bg-white px-3 py-2.5 text-sm leading-5 text-[#172033] outline-none focus:border-[#1769E0] focus:ring-2 focus:ring-[#1769E0]/15 disabled:bg-[#F3F6FA] disabled:text-[#8A96A8]"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <a href={"/tenants/" + encodeURIComponent(tenantId) + "/help"} className="text-xs font-medium text-[#0F56A7] hover:underline">Open full Help</a>
            <Button variant="primary" type="submit" disabled={sending || !question.trim() || status.data?.available !== true}>
              {sending ? "Sending…" : "Ask ResourceBot"}
            </Button>
          </div>
        </form>
      </aside>
    </div> : null}
  </>;
}
