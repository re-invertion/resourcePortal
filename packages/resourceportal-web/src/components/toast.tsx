import { useEffect, useState } from "react";
import { CheckIcon, InfoIcon, WarningIcon, XIcon } from "./design-system";

export type ToastTone = "success" | "danger" | "warning" | "info";

type ToastInput = {
  tone: ToastTone;
  title: string;
  description?: string;
  durationMs?: number;
};

type ToastItem = ToastInput & {
  id: string;
};

const TOAST_EVENT = "resourceportal:toast";
let toastSequence = 0;
const handledErrors = new WeakSet<object>();

function toastId() {
  toastSequence += 1;
  return `rp-toast-${Date.now()}-${toastSequence}`;
}

function emit(input: ToastInput) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastItem>(TOAST_EVENT, {
    detail: { ...input, id: toastId() },
  }));
}

export const toast = {
  show(input: ToastInput) {
    emit(input);
  },
  success(title: string, description?: string) {
    emit({ tone: "success", title, description });
  },
  error(title: string, description?: string) {
    emit({ tone: "danger", title, description, durationMs: 9000 });
  },
  errorFrom(cause: unknown, fallback = "The request could not be completed.") {
    if (cause && typeof cause === "object") {
      if (handledErrors.has(cause)) return;
      handledErrors.add(cause);
    }
    emit({
      tone: "danger",
      title: cause instanceof Error ? cause.message : fallback,
      durationMs: 9000,
    });
  },
  warning(title: string, description?: string) {
    emit({ tone: "warning", title, description, durationMs: 8000 });
  },
  info(title: string, description?: string) {
    emit({ tone: "info", title, description });
  },
};

function ToastGlyph({ tone }: { tone: ToastTone }) {
  const className = "mt-0.5 shrink-0";
  if (tone === "success") return <CheckIcon className={className} size={18} />;
  if (tone === "info") return <InfoIcon className={className} size={18} />;
  return <WarningIcon className={className} size={18} />;
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(
      () => onDismiss(item.id),
      item.durationMs ?? 5500,
    );
    return () => window.clearTimeout(timer);
  }, [item.durationMs, item.id, onDismiss]);

  const toneClasses: Record<ToastTone, string> = {
    success: "border-[#A9D6B6] text-[#107C10]",
    danger: "border-[#E6B4AF] text-[#C42B1C]",
    warning: "border-[#E5C07B] text-[#8A5A00]",
    info: "border-[#A9C7EE] text-[#1769E0]",
  };

  return (
    <div
      className={`pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-white p-4 shadow-[0_12px_32px_rgba(23,32,51,.16)] ${toneClasses[item.tone]}`}
      role={item.tone === "danger" ? "alert" : "status"}
      aria-atomic="true"
      data-toast-tone={item.tone}
    >
      <ToastGlyph tone={item.tone} />
      <div className="min-w-0 flex-1">
        <strong className="block break-words text-sm font-semibold text-[#172033]">{item.title}</strong>
        {item.description ? <p className="mt-1 break-words text-xs leading-5 text-[#5B6678]">{item.description}</p> : null}
      </div>
      <button
        type="button"
        className="-mr-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#718096] hover:bg-[#F3F6FA] hover:text-[#172033]"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ToastItem>).detail;
      if (!detail?.id || !detail.title) return;
      setItems((current) => [...current.slice(-4), detail]);
    };
    window.addEventListener(TOAST_EVENT, listener);
    return () => window.removeEventListener(TOAST_EVENT, listener);
  }, []);

  const dismiss = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Notifications"
    >
      {items.map((item) => <ToastCard key={item.id} item={item} onDismiss={dismiss} />)}
    </div>
  );
}
