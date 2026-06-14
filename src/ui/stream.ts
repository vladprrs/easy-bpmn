// SSE live-tail of D1 history_events (design §11). The Worker tails `history_events`
// by rowid cursor and emits each new row as an SSE event with `id:<cursor>`, so
// EventSource resumes with Last-Event-ID across the bounded (~25 s) connection.
// Reads D1 ONLY (never Workflow state) — the inspection invariant. The loop sleeps
// between reads (≈0 CPU) and MUST abort on client disconnect (request.signal).

import type { Env } from "../env";
import { getInstanceRow } from "../persistence/instances";
import { tailInstanceHistory } from "../persistence/history";
import { requireSession } from "./session";
import { json } from "./http";

const CONNECTION_BUDGET_MS = 25_000; // close → EventSource auto-reconnects (Last-Event-ID)
const POLL_INTERVAL_MS = 1_000;
const BATCH_LIMIT = 200;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function handleInstanceStream(env: Env, instanceId: string, request: Request): Promise<Response> {
  await requireSession(env, request);
  const instance = await getInstanceRow(env.DB, instanceId);
  if (!instance) return json({ error: `Process instance ${instanceId} not found.` }, 404);

  // Resume point: Last-Event-ID (reconnect) or ?since= (first connect), else from start.
  const url = new URL(request.url);
  const lastEventId = request.headers.get("last-event-id") ?? url.searchParams.get("since");
  const startCursor = lastEventId != null && lastEventId !== "" ? parseInt(lastEventId, 10) : null;

  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* stream already closed by the consumer */
        }
      };
      send("retry: 3000\n\n");
      send(": connected\n\n");

      let cursor: number | null = Number.isNaN(startCursor as number) ? null : startCursor;
      const budgetMs = env.UI_STREAM_BUDGET_MS ? parseInt(env.UI_STREAM_BUDGET_MS, 10) : CONNECTION_BUDGET_MS;
      const deadline = Date.now() + (Number.isNaN(budgetMs) ? CONNECTION_BUDGET_MS : budgetMs);
      try {
        while (!signal.aborted && Date.now() < deadline) {
          const { rows, nextCursor } = await tailInstanceHistory(env.DB, instanceId, cursor, BATCH_LIMIT);
          for (const r of rows) {
            send(`id: ${r.cursor}\ndata: ${JSON.stringify(r.event)}\n\n`);
          }
          cursor = nextCursor;
          send(": ping\n\n");
          if (signal.aborted) break;
          await abortableSleep(POLL_INTERVAL_MS, signal);
        }
      } catch {
        /* swallow — the connection ends, EventSource reconnects */
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
