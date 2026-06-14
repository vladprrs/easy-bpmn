// Live history tail (design §11). Prefer the SSE endpoint; EventSource sends the
// session cookie automatically (same-origin) and reconnects with Last-Event-ID
// across the Worker's bounded ~25s connections. Hard failure ⇒ fall back to
// short-poll on the same delta contract (GET /history?since=cursor).

import { api } from "./client";
import type { HistoryEvent } from "./types";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "polling";

export interface StreamHandle {
  close(): void;
}

export function subscribeInstanceHistory(
  instanceId: string,
  sinceCursor: number | null,
  handlers: { onEvents: (events: HistoryEvent[], cursor: number | null) => void; onStatus: (s: LiveStatus) => void },
): StreamHandle {
  let closed = false;
  let cursor = sinceCursor;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let es: EventSource | undefined;

  const startPolling = () => {
    if (closed) return;
    handlers.onStatus("polling");
    const tick = async () => {
      if (closed) return;
      try {
        const page = await api.instanceHistory(instanceId, cursor ?? 0);
        if (page.events.length > 0) {
          cursor = page.nextCursor ?? cursor;
          handlers.onEvents(page.events, cursor);
        }
      } catch {
        /* keep polling; transient */
      }
      if (!closed) pollTimer = setTimeout(tick, 2500);
    };
    void tick();
  };

  try {
    const path = `/instances/${encodeURIComponent(instanceId)}/stream${cursor != null ? `?since=${cursor}` : ""}`;
    es = new EventSource(path, { withCredentials: true });
    handlers.onStatus("connecting");
    es.onopen = () => handlers.onStatus("live");
    es.onmessage = (e: MessageEvent) => {
      if (!e.data) return;
      try {
        const ev = JSON.parse(e.data) as HistoryEvent;
        if (e.lastEventId) {
          const c = parseInt(e.lastEventId, 10);
          if (!Number.isNaN(c)) cursor = c;
        }
        handlers.onEvents([ev], cursor);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        startPolling(); // hard failure → poll
      } else {
        handlers.onStatus("reconnecting"); // normal bounded-connection cycle
      }
    };
  } catch {
    startPolling();
  }

  return {
    close() {
      closed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    },
  };
}
