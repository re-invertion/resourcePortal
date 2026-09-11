import { useEffect, useRef, useState } from "react";

export type CommandAction = {
  id: string;
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  destructive?: boolean;
  overflow?: boolean;
};

export function CommandBar({ actions, ariaLabel = "Resource actions" }: { actions: CommandAction[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inlineActions = actions.filter((action) => !action.overflow);
  const overflowActions = actions.filter((action) => action.overflow);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  function activate(action: CommandAction) {
    if (action.disabled) return;
    setOpen(false);
    action.onClick?.();
  }

  return <div className="rp-command-bar" role="toolbar" aria-label={ariaLabel} ref={rootRef}>
    <div className="rp-command-actions">
      {inlineActions.map((action) => action.href ? <a
        className="rp-command-action"
        data-destructive={action.destructive || undefined}
        aria-disabled={action.disabled || undefined}
        href={action.disabled ? undefined : action.href}
        key={action.id}
      >{action.label}</a> : <button
        className="rp-command-action"
        data-destructive={action.destructive || undefined}
        disabled={action.disabled}
        type="button"
        onClick={() => activate(action)}
        key={action.id}
      >{action.label}</button>)}
      {overflowActions.length ? <div className="rp-command-overflow">
        <button
          className="rp-command-action rp-command-more"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >More actions</button>
        {open ? <div className="rp-command-menu" role="menu" aria-label="More actions">
          {overflowActions.map((action) => action.href ? <a
            className="rp-command-menu-item"
            data-destructive={action.destructive || undefined}
            aria-disabled={action.disabled || undefined}
            href={action.disabled ? undefined : action.href}
            role="menuitem"
            key={action.id}
            onClick={() => setOpen(false)}
          >{action.label}</a> : <button
            className="rp-command-menu-item"
            data-destructive={action.destructive || undefined}
            disabled={action.disabled}
            type="button"
            role="menuitem"
            onClick={() => activate(action)}
            key={action.id}
          >{action.label}</button>)}
        </div> : null}
      </div> : null}
    </div>
  </div>;
}
