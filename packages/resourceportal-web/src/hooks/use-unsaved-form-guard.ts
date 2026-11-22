import { useEffect, useState } from "react";

/**
 * Protect edits which have not been persisted to the API.
 * A saved App Group draft is NOT a dirty form: deployment is a separate action.
 * The capture listener also covers links outside the editor (sidebar/topbar).
 */
export function useUnsavedFormGuard() {
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onNavigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!link || link.hasAttribute("download") || link.getAttribute("target") === "_blank") return;
      const href = link.getAttribute("href");
      if (!href) return;
      const destination = new URL(href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search && destination.hash === window.location.hash) return;
      if (!window.confirm("You have unsaved changes. Leave this page and discard your edits?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onNavigate, true);
    };
  }, [dirty]);

  return { dirty, markDirty: () => setDirty(true), clearDirty: () => setDirty(false) };
}
