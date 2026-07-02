# CF-semantics probe (promoted)

A **separate, standalone** Cloudflare Worker — NOT part of `easy-bpmn`, NOT run by
`npm run test:wf`. It is the minimal reproduction that proved the Cloudflare
Workflows step-semantics the single-wake engine (TASK-54) depends on, and the
regression that catches a future platform change.

The truth-table it establishes (design §4.3):

- **ProbeB** — multi-`waitForEvent` with shrinking membership: **HANGS** on real
  Cloudflare Workflows. This is the L6.6 failure mode (why the orchestrator must
  collapse to ONE replay-stable wait).
- **ProbeC** — a single replay-stable `waitForEvent({name: wake#k})` per parked
  pass with a bounded backstop: **COMPLETES**, and **self-heals** when a wake is
  lost (the timeout fires → re-walk). This is the shape `src/runtime/engine.ts` +
  `src/runtime/wake.ts` implement.

## Run (manual, against real CF or wrangler dev)

```bash
cd tests/workflow-mode/probe
npm install
npx wrangler dev            # local miniflare, or:
npx wrangler deploy         # a throwaway *.workers.dev for the real-CF truth-table
```

It needs its own KV namespace + the three Workflow bindings in `wrangler.jsonc`.
Kept here as executable evidence; the orchestrator's own Layer-B coverage lives in
the sibling `*.wf.test.ts` suites.
