// Small interaction primitives for the Process Stage: an anchored, light-dismiss
// Popover (portaled + position:fixed so it escapes the hero's overflow) that flips to
// open ABOVE when it would overflow below, clamps into the viewport (width + height, so
// it collapses onto a phone), scrolls its own body, and hands focus back to its trigger
// on close — plus a keycap and a shared debounce hook. Dependency-light,
// keyboard-accessible. One elevation language (hairline + a single soft shadow),
// matching the cards. No glass.

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Debounce a fast-changing value (search terms) before it drives a network query. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-card px-1.5 py-0.5 font-data text-2xs font-medium text-content-secondary shadow-xs">
      {children}
    </kbd>
  );
}

type Pos = { top: number; left: number; minWidth: number; maxWidth: number; maxHeight: number };

/** Anchored popover. `trigger` renders the button (gets {open, toggle, ref}); `children`
 *  renders the panel (gets a `close` fn). Light-dismiss on outside-click + Escape.
 *  `ariaLabel` names the panel's role=dialog for screen readers. */
export function Popover({
  trigger,
  children,
  align = "start",
  width,
  ariaLabel,
}: {
  trigger: (o: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  width?: number;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const place = () => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const gap = 8;
    const margin = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Never wider than the viewport (minus a margin each side), so the panel
    // collapses cleanly onto a narrow phone instead of spilling off-screen.
    const maxWidth = Math.max(200, vw - 2 * margin);
    const minWidth = Math.min(width ?? a.width, maxWidth);
    const panelW = panelRef.current?.offsetWidth || minWidth;
    // scrollHeight reports the full content height even once the body is capped,
    // so the flip decision stays stable when the panel scrolls.
    const natural = scrollRef.current?.scrollHeight || 0;

    let left = align === "end" ? a.right - panelW : a.left;
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - panelW - margin));

    const spaceBelow = vh - a.bottom - gap - margin;
    const spaceAbove = a.top - gap - margin;
    const openAbove = natural > spaceBelow && spaceAbove > spaceBelow;

    let top: number;
    let maxHeight: number;
    if (openAbove) {
      maxHeight = Math.max(140, spaceAbove);
      top = Math.max(margin, a.top - gap - Math.min(natural || maxHeight, maxHeight));
    } else {
      top = a.bottom + gap;
      maxHeight = Math.max(140, spaceBelow);
    }

    setPos((prev) =>
      prev &&
      prev.top === top &&
      prev.left === left &&
      prev.minWidth === minWidth &&
      prev.maxWidth === maxWidth &&
      prev.maxHeight === maxHeight
        ? prev
        : { top, left, minWidth, maxWidth, maxHeight },
    );
  };

  // Position on open and stay anchored to scroll / resize. Reads are coalesced into a
  // single rAF so a fast scroll never fires getBoundingClientRect on every frame event.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure once the panel is mounted (real height → correct flip + clamp) and
  // whenever its content resizes (async lists loading in).
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    place();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos !== null]);

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

  // Hand focus back to the trigger on close (Escape, selection, or an outside-click
  // that would otherwise leave focus stranded on <body>). We only reclaim focus when it
  // isn't already on a control the user deliberately moved to.
  useEffect(() => {
    if (!open) return;
    return () => {
      const ae = document.activeElement;
      if (!ae || ae === document.body || panelRef.current?.contains(ae)) {
        anchorRef.current?.focus?.();
      }
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
            aria-label={ariaLabel}
            className="anim-fade fixed z-[200] overflow-hidden rounded-card border border-line bg-surface-card shadow-md"
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxWidth: pos.maxWidth }}
          >
            <div ref={scrollRef} className="overflow-y-auto overscroll-contain" style={{ maxHeight: pos.maxHeight }}>
              {children(close)}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
