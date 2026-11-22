import { useEffect, useRef, useState } from "react";

/**
 * Protect edits which have not been persisted to the API.
 * A saved App Group draft is NOT a dirty form: deployment is a separate action.
 * The capture listener also covers links outside the editor (sidebar/topbar).
 */
export function useUnsavedFormGuard() {
  const [dirty, setDirty] = useState(false);
  const approvedDeparture = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    let resetApproval: ReturnType<typeof setTimeout> | undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedDeparture.current) {
        approvedDeparture.current = false;
        return;
      }
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
        return;
      }
      // Ordinary links trigger beforeunload after the click. One accepted
      // discard must not cause a second native browser confirmation.
      approvedDeparture.current = true;
      if (resetApproval) clearTimeout(resetApproval);
      resetApproval = setTimeout(() => { approvedDeparture.current = false; }, 1500);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onNavigate, true);
    return () => {
      if (resetApproval) clearTimeout(resetApproval);
      approvedDeparture.current = false;
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onNavigate, true);
    };
  }, [dirty]);

  return { dirty, markDirty: () => setDirty(true), clearDirty: () => setDirty(false) };
}
