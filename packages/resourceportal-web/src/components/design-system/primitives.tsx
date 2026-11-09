import { semanticStatusTone } from "../status-tone";
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, InfoIcon, WarningIcon, XIcon } from "./icons";

export function cx(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(" "); }

export function Button({ variant = "secondary", size = "md", className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  return <button className={cx("inline-flex max-w-full min-w-0 items-center justify-center gap-2 rounded-md border font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0] disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm", variant === "primary" && "border-[#1769E0] bg-[#1769E0] text-white hover:bg-[#0f5fcf]", variant === "secondary" && "border-[#B9C5D6] bg-white text-[#172033] hover:bg-[#F4F7FB]", variant === "danger" && "border-[#C42B1C] bg-[#C42B1C] text-white hover:bg-[#a92317]", variant === "ghost" && "border-transparent bg-transparent text-[#42526B] hover:bg-[#EEF3F9]", className)} {...props}>{children}</button>;
}

export function LinkButton({ href, variant = "secondary", className, children }: { href: string; variant?: "primary" | "secondary" | "danger" | "ghost"; className?: string; children: ReactNode }) {
  const variantClass = variant === "primary" ? "border-[#1769E0] bg-[#1769E0] text-white hover:bg-[#0f5fcf]" : variant === "danger" ? "border-[#C42B1C] bg-[#C42B1C] text-white" : variant === "ghost" ? "border-transparent bg-transparent text-[#42526B] hover:bg-[#EEF3F9]" : "border-[#B9C5D6] bg-white text-[#172033] hover:bg-[#F4F7FB]";
  return <a href={href} className={cx("inline-flex h-10 max-w-full min-w-0 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0]", variantClass, className)}>{children}</a>;
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label} className={cx("inline-flex h-8 min-h-0 w-8 shrink-0 items-center justify-center rounded-full !border-0 !bg-transparent !p-0 text-[#526070] !shadow-none transition hover:!bg-[#EEF3F9] hover:text-[#172033] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#1769E0] disabled:opacity-50", className)} {...props}>{children}</button>;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cx("max-w-full min-w-0 rounded-lg border border-[#D7E0EC] bg-white", className)} {...props} />; }

export function Eyebrow({ children }: { children: ReactNode }) { return <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.03em] text-[#1769E0]">{children}</p>; }

export function PageHeader({ eyebrow, title, description, actions, breadcrumbs }: { eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode }) {
  return <header className="mb-7">{breadcrumbs ? <div className="mb-4 text-[13px] text-[#5B6678]">{breadcrumbs}</div> : null}<div className="flex flex-col justify-between gap-4 md:flex-row md:items-start"><div className="min-w-0">{eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}<h1 className="break-words text-[32px] font-semibold leading-[40px] tracking-[-0.025em] text-[#172033]">{title}</h1>{description ? <p className="mt-1 max-w-3xl text-sm leading-5 text-[#5B6678]">{description}</p> : null}</div>{actions ? <div className="flex max-w-full shrink-0 flex-wrap gap-2">{actions}</div> : null}</div></header>;
}

const toneMap = {
  neutral: "border-[#CFD8E6] bg-[#F5F7FA] text-[#526070]",
  success: "border-[#C9EBD9] bg-[#E9F7F0] text-[#137A4A]",
  warning: "border-[#F3DFAC] bg-[#FFF4D6] text-[#9A6700]",
  danger: "border-[#F0C8C4] bg-[#FDEBE9] text-[#C42B1C]",
  info: "border-[#CADDF7] bg-[#E7F1FF] text-[#135FBB]",
};
export type Tone = keyof typeof toneMap;
export function StatusBadge({ children, tone = "neutral", dot = true, className }: { children: ReactNode; tone?: Tone; dot?: boolean; className?: string }) { return <span className={cx("inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium", toneMap[tone], className)}>{dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}{children}</span>; }
export function Tooltip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) { const id = useId(); return <span className={cx("group relative inline-flex", className)}><span tabIndex={0} aria-describedby={id} className="inline-flex cursor-help rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0]">{children}</span><span id={id} role="tooltip" className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-[min(18rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-[#314158] bg-[#172033] px-3 py-2 text-left text-[12px] font-normal leading-4 text-white opacity-0 translate-y-1 shadow-[0_10px_30px_rgba(15,23,42,0.22)] transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"><span aria-hidden="true" className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-[#314158] bg-[#172033]" />{content}</span></span>; }
export function StatusText({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) { const color = tone === "success" ? "text-[#137A4A]" : tone === "warning" ? "text-[#9A6700]" : tone === "danger" ? "text-[#C42B1C]" : tone === "info" ? "text-[#1769E0]" : "text-[#5B6678]"; return <span className={cx("inline-flex items-center gap-1.5 text-[13px] font-medium", color)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>; }
export function statusTone(value: unknown): Tone { return semanticStatusTone(value); }

export function MetricCard({ label, value, detail, icon, tone = "info", loading, error }: { label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode; tone?: Tone; loading?: boolean; error?: unknown }) {
  const accent = tone === "success" ? "border-l-[#20A464]" : tone === "warning" ? "border-l-[#D18B00]" : tone === "danger" ? "border-l-[#C42B1C]" : tone === "neutral" ? "border-l-[#7B8798]" : "border-l-[#1769E0]";
  return <Card className={cx("relative min-h-[92px] border-l-2 p-4", accent)}>{loading ? <div className="animate-pulse space-y-3"><div className="h-3 w-24 rounded bg-[#E7EDF5]"/><div className="h-6 w-20 rounded bg-[#E7EDF5]"/></div> : error ? <><span className="text-xs font-medium text-[#C42B1C]">{label}</span><p className="mt-2 text-sm text-[#5B6678]">Unavailable</p></> : <div className="flex gap-3">{icon ? <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F2F6FC] text-[#1769E0]">{icon}</div> : null}<div className="min-w-0"><div className="text-[13px] text-[#5B6678]">{label}</div><div className="mt-0.5 truncate text-[22px] font-semibold leading-7 text-[#172033]">{value}</div>{detail ? <div className="mt-0.5 truncate text-xs text-[#718096]">{detail}</div> : null}</div></div>}</Card>;
}

export function MetricFilterCard({ label, value, detail, icon, tone = "info", active = false, onClick }: { label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode; tone?: Tone; active?: boolean; onClick: () => void }) {
  const accent = tone === "success" ? "border-l-[#20A464]" : tone === "warning" ? "border-l-[#D18B00]" : tone === "danger" ? "border-l-[#C42B1C]" : tone === "neutral" ? "border-l-[#7B8798]" : "border-l-[#1769E0]";
  return <button type="button" aria-pressed={active} onClick={onClick} className={cx("min-h-[92px] w-full rounded-lg border border-l-2 bg-white p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0]", accent, active ? "border-[#1769E0] bg-[#F8FBFF] ring-2 ring-[#1769E0]/10" : "border-[#D7E0EC] hover:border-[#A9B8CC] hover:bg-[#FBFCFE]")}><div className="flex gap-3">{icon ? <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F2F6FC] text-[#1769E0]">{icon}</div> : null}<div className="min-w-0"><div className="text-[13px] text-[#5B6678]">{label}</div><div className="mt-0.5 truncate text-[22px] font-semibold leading-7 text-[#172033]">{value}</div>{detail ? <div className="mt-0.5 truncate text-xs text-[#718096]">{detail}</div> : null}</div></div></button>;
}

export function Callout({ tone = "info", title, children, action }: { tone?: "info" | "warning" | "danger" | "success"; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const style = tone === "warning" ? "border-[#E8C775] bg-[#FFF9EC] text-[#9A6700]" : tone === "danger" ? "border-[#E4A9A3] bg-[#FFF3F2] text-[#C42B1C]" : tone === "success" ? "border-[#A9DCC2] bg-[#F1FBF6] text-[#137A4A]" : "border-[#B9D4F7] bg-[#F5F9FF] text-[#1769E0]";
  const Icon = tone === "warning" || tone === "danger" ? WarningIcon : tone === "success" ? CheckIcon : InfoIcon;
  return <div role={tone === "danger" ? "alert" : undefined} className={cx("flex flex-col justify-between gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center", style)}><div className="flex min-w-0 gap-3"><Icon size={18} className="mt-0.5 shrink-0"/><div className="min-w-0"><strong className="block break-words text-[#172033]">{title}</strong>{children ? <div className="mt-0.5 break-words text-xs leading-5 text-[#5B6678]">{children}</div> : null}</div></div>{action ? <div className="shrink-0 text-[13px] font-semibold">{action}</div> : null}</div>;
}

export function Tabs({ items, label = "Sections" }: { items: Array<{ label: string; href: string; active?: boolean }>; label?: string }) { return <nav aria-label={label} className="mb-6 max-w-full min-w-0 overflow-x-auto rounded-lg border border-[#D7E0EC] bg-white overscroll-x-contain [contain:layout_paint]"><div className="flex min-w-max px-2">{items.map(item => <a key={item.href} href={item.href} aria-current={item.active ? "page" : undefined} className={cx("relative flex h-12 items-center px-4 text-[13px] font-medium text-[#526070] hover:text-[#135FBB]", item.active && "text-[#0F4F9B] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-[#1769E0]")}>{item.label}</a>)}</div></nav>; }

/** Block page/background accessibility while a React-portal modal is open.
 * Store and restore existing states even when another modal is opened above it.
 */
export const DIALOG_LAYER_CHANGE_EVENT = "resourceportal:dialog-layer-change";
const openDialogOverlays: HTMLDivElement[] = [];

/**
 * Notifications must be rendered *inside* the topmost role=dialog rather
 * than #root, which is inert and aria-hidden while a modal is open.
 * Return null on SSR and after the last modal closes.
 */
export function getActiveDialogContent(): HTMLElement | null {
  return openDialogOverlays.at(-1)?.querySelector<HTMLElement>('[role="dialog"]') ?? null;
}
const originalBackgroundState = new Map<Element, { inert: string | null; ariaHidden: string | null }>();
let dialogBodyObserver: MutationObserver | undefined;
// The outer modal can unmount before an inner modal in the same React commit.
// Retain the *page* trigger until the final overlay leaves; the inner trigger
// may already have been removed when its own effect cleanup runs.
let rootPageReturnFocus: HTMLElement | null = null;


function updateDialogBackground() {
  for (const [element, previous] of originalBackgroundState) {
    if (previous.inert === null) element.removeAttribute("inert");
    else element.setAttribute("inert", previous.inert);
    if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", previous.ariaHidden);
  }
  originalBackgroundState.clear();
  const topmost = openDialogOverlays.at(-1);
  if (!topmost) return;
  for (const child of Array.from(document.body.children)) {
    if (child === topmost) continue;
    originalBackgroundState.set(child, {
      inert: child.getAttribute("inert"),
      ariaHidden: child.getAttribute("aria-hidden"),
    });
    child.setAttribute("inert", "");
    child.setAttribute("aria-hidden", "true");
  }
}

export function Dialog({ open, title, description, children, actions, onClose, danger = false }: { open: boolean; title: string; description?: ReactNode; children?: ReactNode; actions?: ReactNode; onClose: () => void; danger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose); const titleId = useId(); const descId = useId();
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open || !ref.current || !overlayRef.current) return;
    const dialog = ref.current;
    const overlay = overlayRef.current;
    const previous = document.activeElement as HTMLElement | null;
    if (openDialogOverlays.length === 0) rootPageReturnFocus = previous;
    openDialogOverlays.push(overlay);
    updateDialogBackground();
    window.dispatchEvent(new Event(DIALOG_LAYER_CHANGE_EVENT));
    if (!dialogBodyObserver && typeof MutationObserver !== "undefined") {
      dialogBodyObserver = new MutationObserver(updateDialogBackground);
      dialogBodyObserver.observe(document.body, { childList: true });
    }

    // Query at keypress time: conditional/disabled controls can change.
    const focusableSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';
    const isVisibleThroughParents = (element: HTMLElement) => {
      // A descendant of display:none still has its own computed display:block.
      // Inspect every wrapper, including dynamic Tailwind "hidden" elements.
      for (let node: HTMLElement | null = element; node && dialog.contains(node); node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse") return false;
      }
      return true;
    };
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(element => element.tabIndex >= 0 &&
        !element.matches(":disabled") &&
        !element.closest("[hidden], [inert], [aria-hidden='true']") &&
        isVisibleThroughParents(element));
    const body = dialog.querySelector<HTMLElement>("[data-dialog-body]");
    const initial = Array.from(body?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
      .find(element => focusable().includes(element));
    (initial ?? focusable()[0] ?? dialog).focus();

    const isTopmost = () => openDialogOverlays.at(-1) === overlay;
    const key = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (!isTopmost() || dialog.contains(event.target as Node)) return;
      (focusable()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("focusin", containFocus);
      const index = openDialogOverlays.indexOf(overlay);
      if (index >= 0) openDialogOverlays.splice(index, 1);
      updateDialogBackground();
      window.dispatchEvent(new Event(DIALOG_LAYER_CHANGE_EVENT));
      if (openDialogOverlays.length === 0) {
        dialogBodyObserver?.disconnect();
        dialogBodyObserver = undefined;
      }
      // Only the final cleanup can restore the page trigger if an outer
      // overlay was torn down before its inner overlay in the same React batch.
      const returnTarget = previous?.isConnected && !previous.closest("[inert]")
        ? previous
        : openDialogOverlays.length === 0 ? rootPageReturnFocus : null;
      if (returnTarget?.isConnected && !returnTarget.closest("[inert]")) returnTarget.focus();
      if (openDialogOverlays.length === 0) rootPageReturnFocus = null;
    };
  }, [open]);
  if (!open) return null;
  const dialog = <div ref={overlayRef} data-rp-dialog-overlay className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0E1A2B]/45 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg min-w-0 overflow-y-auto rounded-xl border border-[#D7E0EC] bg-white shadow-2xl"><header className="flex items-start justify-between gap-4 border-b border-[#E1E7F0] p-5"><div><h2 id={titleId} className={cx("text-lg font-semibold", danger ? "text-[#A92317]" : "text-[#172033]")}>{title}</h2>{description ? <p id={descId} className="mt-1 text-sm text-[#5B6678]">{description}</p> : null}</div><IconButton label="Close dialog" onClick={() => onCloseRef.current()}><XIcon /></IconButton></header>{children ? <div data-dialog-body className="p-5">{children}</div> : null}{actions ? <footer className="flex justify-end gap-2 border-t border-[#E1E7F0] bg-[#F8FAFD] p-4">{actions}</footer> : null}</div></div>;
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export function ConfirmActionButton({ children, confirmTitle, confirmDescription, confirmLabel = "Confirm", onConfirm, triggerVariant = "secondary", confirmVariant = "danger", size = "md", disabled = false, ariaLabel, className }: { children: ReactNode; confirmTitle: string; confirmDescription?: ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<void>; triggerVariant?: "primary" | "secondary" | "danger" | "ghost"; confirmVariant?: "primary" | "danger"; size?: "sm" | "md"; disabled?: boolean; ariaLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  async function confirm() {
    setWorking(true);
    try { await onConfirm(); setOpen(false); } finally { setWorking(false); }
  }
  return <><Button type="button" variant={triggerVariant} size={size} className={className} aria-label={ariaLabel} disabled={disabled || working} onClick={event => { event.currentTarget.focus(); setOpen(true); }}>{children}</Button><Dialog open={open} onClose={() => { if (!working) setOpen(false); }} title={confirmTitle} description={confirmDescription} danger={confirmVariant === "danger"} actions={<><Button disabled={working} onClick={() => setOpen(false)}>Cancel</Button><Button variant={confirmVariant} disabled={working} onClick={() => void confirm()}>{working ? "Working…" : confirmLabel}</Button></>} /></>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) { return <div className="flex min-h-44 flex-col items-center justify-center px-6 py-10 text-center">{icon ? <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">{icon}</div> : null}<strong className="text-sm text-[#172033]">{title}</strong>{description ? <p className="mt-1 max-w-md break-words text-sm text-[#5B6678]">{description}</p> : null}{action ? <div className="mt-4">{action}</div> : null}</div>; }
export function ErrorState({ title = "We couldn't load this section", error, retry }: { title?: string; error?: unknown; retry?: () => void }) { return <Callout tone="danger" title={title} action={retry ? <button className="underline" onClick={retry}>Try again</button> : undefined}>{error instanceof Error ? error.message : "The request could not be completed."}</Callout>; }
export function LoadingState({ rows = 4 }: { rows?: number }) { return <div className="animate-pulse space-y-3 p-4">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-12 rounded bg-[#EEF2F7]" />)}</div>; }