// BPMN render + live execution overlay (design §10). Renders author DI when present;
// otherwise synthesizes bpmndi via bpmn-auto-layout (ELK→DI) — a HARD prerequisite,
// because bpmn-js draws nothing for a DI-less definition and overlays need rendered
// shapes. Overlay (traversed path, current frontier, failed element, gateway
// decisions, compensated handlers) is keyed by element_id (1:1 with history). On any
// failure it degrades to an element list so the rest of the hub keeps working.
//
// Default export so callers can React.lazy() it (code-split the heavy bpmn-js bundle).

import { useEffect, useRef, useState } from "react";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { layoutProcess } from "bpmn-auto-layout";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import type { BpmnElement } from "../api/types";

export interface DiagramOverlay {
  traversed: string[];
  current: string[];
  failed: { elementId: string; reason: string }[];
  compensated: string[];
  badges: { elementId: string; text: string; tone: "ok" | "danger" | "warn" | "accent" }[];
}

const MARKER = {
  traversed: "ebpmn-traversed",
  current: "ebpmn-current",
  failed: "ebpmn-failed",
  compensated: "ebpmn-compensated",
};

async function hasDi(xml: string): Promise<boolean> {
  return /<bpmndi:BPMNDiagram|<BPMNDiagram/.test(xml);
}

export default function BpmnViewer({
  bpmnXml,
  elements,
  overlay,
  onSelectElement,
}: {
  bpmnXml: string | null;
  elements: BpmnElement[];
  overlay: DiagramOverlay;
  onSelectElement: (id: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const appliedMarkers = useRef<{ id: string; cls: string }[]>([]);
  const overlayIds = useRef<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Import (only on XML change).
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setFailed(null);
    if (!bpmnXml || !hostRef.current) {
      setFailed(bpmnXml ? null : "No BPMN XML available.");
      return;
    }
    const viewer = new NavigatedViewer({ container: hostRef.current });
    viewerRef.current = viewer;

    (async () => {
      try {
        const xml = (await hasDi(bpmnXml)) ? bpmnXml : await layoutProcess(bpmnXml);
        await viewer.importXML(xml);
        if (disposed) return;
        viewer.get("canvas").zoom("fit-viewport", "auto");
        viewer.on("element.click", (e: any) => {
          const id = e?.element?.id;
          if (id) onSelectElement(id);
        });
        setReady(true);
      } catch (err) {
        if (!disposed) setFailed(err instanceof Error ? err.message : "Diagram render failed.");
      }
    })();

    return () => {
      disposed = true;
      try {
        viewer.destroy();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
      appliedMarkers.current = [];
      overlayIds.current = [];
    };
  }, [bpmnXml, onSelectElement]);

  // Apply / refresh the live overlay (on overlay change once the diagram is ready).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    let canvas: any;
    let overlays: any;
    try {
      canvas = viewer.get("canvas");
      overlays = viewer.get("overlays");
    } catch {
      return;
    }

    // Clear previous markers + overlays.
    for (const m of appliedMarkers.current) {
      try {
        canvas.removeMarker(m.id, m.cls);
      } catch {
        /* element no longer present */
      }
    }
    appliedMarkers.current = [];
    for (const id of overlayIds.current) {
      try {
        overlays.remove(id);
      } catch {
        /* ignore */
      }
    }
    overlayIds.current = [];

    const addMarker = (id: string, cls: string) => {
      try {
        canvas.addMarker(id, cls);
        appliedMarkers.current.push({ id, cls });
      } catch {
        /* element id not in this diagram — skip */
      }
    };

    overlay.traversed.forEach((id) => addMarker(id, MARKER.traversed));
    overlay.compensated.forEach((id) => addMarker(id, MARKER.compensated));
    overlay.current.forEach((id) => addMarker(id, MARKER.current));
    overlay.failed.forEach((f) => addMarker(f.elementId, MARKER.failed));

    const addBadge = (id: string, text: string, tone: string) => {
      try {
        const oid = overlays.add(id, { position: { top: -10, left: -4 }, html: `<div class="ebpmn-overlay-badge ${tone}">${text}</div>` });
        overlayIds.current.push(oid);
      } catch {
        /* skip */
      }
    };
    overlay.failed.forEach((f) => addBadge(f.elementId, "✕ " + f.reason.slice(0, 32), "danger"));
    overlay.badges.forEach((b) => addBadge(b.elementId, b.text, b.tone));
  }, [overlay, ready]);

  if (failed) {
    // Degradation: element-list fallback (design §10).
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
        <div className="mb-2 text-xs text-warn">Diagram unavailable ({failed}). Showing the element list.</div>
        <ul className="grid max-h-[50vh] grid-cols-2 gap-1 overflow-auto md:grid-cols-3">
          {elements
            .filter((e) => !["sequenceFlow", "association"].includes(e.type))
            .map((e) => {
              const isFailed = overlay.failed.some((f) => f.elementId === e.elementId);
              const isCurrent = overlay.current.includes(e.elementId);
              return (
                <li key={e.elementId}>
                  <button
                    onClick={() => onSelectElement(e.elementId)}
                    className={`w-full truncate rounded border px-2 py-1 text-left text-xs ${
                      isFailed
                        ? "border-danger/50 bg-danger/10 text-danger"
                        : isCurrent
                          ? "border-ok/50 bg-ok/10 text-ok"
                          : "border-ink-700 bg-ink-900 text-slate-300"
                    }`}
                    title={e.elementId}
                  >
                    <span className="text-slate-500">{e.type}</span> {e.name || e.elementId}
                  </button>
                </li>
              );
            })}
        </ul>
      </div>
    );
  }

  return (
    <div className="relative rounded-lg border border-ink-700 bg-ink-850">
      <div ref={hostRef} className="h-[420px] w-full" />
      {!ready && <div className="absolute inset-0 grid place-items-center text-xs text-slate-500">rendering diagram…</div>}
    </div>
  );
}
