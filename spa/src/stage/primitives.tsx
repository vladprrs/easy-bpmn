// Small interaction primitives for the Process Stage: an anchored, light-dismiss
// Popover (portaled + position:fixed so it escapes the hero's overflow), a keycap, and
// a glass panel. Dependency-light, keyboard-accessible.

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-card px-1.5 py-0.5 font-data text-2xs font-medium text-content-secondary shadow-xs">
      {children}
    </kbd>
  );
}

/** Anchored popover. `trigger` renders the button (gets {open, toggle, ref}); `children`
 *  renders the panel (gets a `close` fn). Light-dismiss on outside-click + Escape. */
export function Popover({
  trigger,
  children,
  align = "start",
  width,
}: {
  trigger: (o: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const place = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 8, left: align === "end" ? r.right : r.left, minWidth: width ?? r.width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: (el) => (anchorRef.current = el) })}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            className="anim-fade fixed z-[200] overflow-hidden rounded-card border border-line bg-surface-card shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.minWidth,
              transform: align === "end" ? "translateX(-100%)" : undefined,
            }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
