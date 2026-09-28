import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import { BotIcon, Button, XIcon } from "./design-system";
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

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

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
      className="group fixed bottom-5 right-5 z-[60] flex h-12 items-center gap-2.5 rounded-2xl border border-[#0F5FCF] bg-[#1769E0] px-3.5 text-sm font-semibold text-white shadow-[0_12px_32px_rgba(23,105,224,.30)] transition duration-200 hover:-translate-y-0.5 hover:border-[#0F5FCF] hover:bg-[#0F5FCF] hover:shadow-[0_16px_36px_rgba(23,105,224,.34)] active:translate-y-0"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-white/14 ring-1 ring-inset ring-white/15 transition group-hover:bg-white/18">
        <BotIcon size={18} />
      </span>
      <span className="hidden pr-0.5 sm:inline">ResourceBot</span>
    </button>

    {open ? <div
      className="rp-resource-bot-backdrop fixed inset-0 z-[80] flex items-end justify-end bg-[#0E1A2B]/30 p-3 backdrop-blur-[2px] sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="ResourceBot"
        className="rp-resource-bot-dialog flex h-[min(760px,calc(100dvh-1.5rem))] w-full max-w-[448px] flex-col overflow-hidden rounded-[22px] border border-[#D7E0EC] bg-white shadow-[0_28px_80px_rgba(15,23,42,.24),0_8px_28px_rgba(15,23,42,.12)] sm:h-[min(720px,calc(100dvh-6.5rem))]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#DDE5F0] bg-[linear-gradient(135deg,#F8FBFF_0%,#F2F7FE_62%,#EEF5FF_100%)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#1769E0] text-white shadow-[0_6px_16px_rgba(23,105,224,.22)]">
              <BotIcon size={21}/>
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#F4F8FE] bg-[#22A06B]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#172033]">ResourceBot</h2>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close ResourceBot"
            title="Close"
            onClick={() => setOpen(false)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#D7E0EC] bg-white/80 p-0 text-[#526070] shadow-sm transition duration-150 hover:border-[#C4D0DF] hover:bg-white hover:text-[#172033] active:scale-95"
          >
            <XIcon size={17}/>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[#FBFCFE] px-4 py-5">
          {status.loading ? <div className="flex items-center gap-2 px-1 text-sm text-[#718096]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#1769E0]" aria-hidden="true" />
            Checking ResourceBot availability…
          </div> : status.error ? (
            <div className="rounded-xl border border-[#F2C7C7] bg-[#FFF6F6] p-3 text-sm text-[#9B2C2C]">ResourceBot status could not be loaded.</div>
          ) : status.data?.available !== true ? (
            <div className="rounded-xl border border-[#E9D9A7] bg-[#FFF9E8] p-3 text-sm text-[#725B19]">
              <strong className="block">ResourceBot unavailable</strong>
              <span className="mt-1 block text-xs leading-5">{reasonText(status.data?.reason)}</span>
            </div>
          ) : null}

          {messages.length === 0 ? <div className="mx-auto flex max-w-[330px] flex-col items-center px-3 py-8 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-[18px] border border-[#DCE8F7] bg-white text-[#1769E0] shadow-[0_8px_24px_rgba(15,23,42,.06)]">
              <BotIcon size={25}/>
            </span>
            <strong className="text-[15px] font-semibold text-[#172033]">How can I help?</strong>
            <p className="mt-1.5 text-xs leading-5 text-[#718096]">
              Ask about applications, domains, persistent storage, private networking, credentials, billing or deployments.
            </p>
          </div> : messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "ml-10 flex justify-end" : "mr-5 flex items-start gap-2.5"}>
              {message.role === "assistant" ? <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><BotIcon size={15}/></span> : null}
              <div className={message.role === "user" ? "max-w-[88%]" : "min-w-0 flex-1"}>
                <div className={message.role === "user"
                  ? "rounded-2xl rounded-br-md bg-[#1769E0] px-4 py-3 text-sm leading-6 text-white shadow-sm"
                  : "rounded-2xl rounded-tl-md border border-[#DDE5F0] bg-white px-4 py-3 text-sm leading-6 text-[#263449] shadow-[0_3px_12px_rgba(15,23,42,.04)]"}>
                  {message.content}
                </div>
                {message.role === "assistant" && message.sources?.length ? <div className="mt-2 flex flex-wrap gap-2">
                  {message.sources.map((source) => <a key={source.chunkId} href={source.href} className="rounded-full border border-[#C9D8EB] bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F56A7] transition hover:border-[#AFC4DE] hover:bg-[#EAF3FF]">{source.title}</a>)}
                </div> : null}
                {message.role === "assistant" && message.usage ? <p className="mt-1.5 text-[10px] text-[#8A96A8]">
                  {message.usage.totalTokens.toLocaleString()} tokens · {message.usage.chargedCredits} credits
                </p> : null}
              </div>
            </div>
          ))}

          {sending ? <div className="mr-5 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><BotIcon size={15}/></span>
            <div className="rounded-2xl rounded-tl-md border border-[#DDE5F0] bg-white px-4 py-3 text-sm text-[#718096] shadow-[0_3px_12px_rgba(15,23,42,.04)]">
              <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#1769E0]" />Checking Help…</span>
            </div>
          </div> : null}
          {error ? <div className="rounded-xl border border-[#F2C7C7] bg-[#FFF6F6] p-3 text-sm text-[#9B2C2C]">{error}</div> : null}
        </div>

        <form className="m-0 border-t border-[#E1E7F0] bg-white p-4" onSubmit={(event) => void send(event)}>
          <label className="sr-only" htmlFor="resourcebot-question">Ask ResourceBot</label>
          <div className="rounded-2xl border border-[#B9C5D6] bg-white p-2 shadow-[0_4px_16px_rgba(15,23,42,.05)] transition focus-within:border-[#1769E0] focus-within:ring-2 focus-within:ring-[#1769E0]/12">
            <textarea
              id="resourcebot-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={sending || status.data?.available !== true}
              maxLength={4000}
              rows={3}
              placeholder={status.data?.available ? "Ask a question about ResourcePortal…" : "ResourceBot is unavailable"}
              className="min-h-[76px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 text-[#172033] shadow-none outline-none focus:border-0 focus:ring-0 disabled:bg-transparent disabled:text-[#8A96A8]"
            />
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-[#EEF2F7] px-1 pt-2">
              <span className="pl-1 text-[10px] text-[#9AA6B6]">{question.length.toLocaleString()} / 4,000</span>
              <Button variant="primary" type="submit" disabled={sending || !question.trim() || status.data?.available !== true} className="min-h-9 rounded-xl px-3.5 text-xs">
                {sending ? "Sending…" : "Ask ResourceBot"}
              </Button>
            </div>
          </div>
        </form>
      </aside>
    </div> : null}
  </>;
}
