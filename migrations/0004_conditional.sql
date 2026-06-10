-- Conditional sagas (M2) — additive D1 deltas over 0003_topology.sql.
--
-- Storage substrate for data-driven branching + cycles (M2 design 2026-06-09
-- §5/§6/§8/§9): the OCCURRENCE discriminator (a loop re-runs the SAME element id
-- N times per instance, so the M1 uniqueness shapes gain a per-visit counter),
-- the output_applied write-free fast-forward marker, the conditional topology
-- columns on bpmn_elements, and the gateway_decisions audit/replay table. No
-- runtime behavior lives here.
--
-- This pays the debt flagged in 0002 ("this shape is NOT stable past M1"): the
-- token/iteration discriminator is `occurrence`, defaulting to 0 so every
-- existing row and every M1 call site keeps its exact prior semantics.
--
-- Migrations are applied exactly once (tracked by the migration runner), so the
-- ALTER TABLE ... ADD COLUMN statements (which SQLite cannot guard with
-- IF NOT EXISTS) are safe; CREATE statements use IF NOT EXISTS for belt-and-braces.

-- ---------------------------------------------------------------------------
-- service_task_jobs — one job row PER ITERATION of an element (design §5).
-- `occurrence` is the walk-local visit counter; `output_applied` marks a
-- completed job whose output the engine has already merged + advanced past, so
-- the rewalk-from-start treats it as write-free fast-forward (re-applying would
-- re-merge an old iteration's output over newer variables). A compensation job
-- inherits its forward step's occurrence (design §8).
-- ---------------------------------------------------------------------------
ALTER TABLE service_task_jobs ADD COLUMN occurrence     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_task_jobs ADD COLUMN output_applied INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS uq_jobs_instance_element_kind;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_instance_element_kind
  ON service_task_jobs (instance_id, element_id, is_compensation, occurrence);

-- ---------------------------------------------------------------------------
-- saga_steps — each completed pass of a compensatable step is its OWN ledger
-- row (design §8), so the existing reverse pass (ORDER BY seq DESC) compensates
-- every iteration separately with zero algorithm change. The INSERT OR IGNORE
-- dedup contract is preserved per iteration.
-- ---------------------------------------------------------------------------
ALTER TABLE saga_steps ADD COLUMN occurrence INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS uq_saga_steps_forward;
CREATE UNIQUE INDEX IF NOT EXISTS uq_saga_steps_forward
  ON saga_steps (instance_id, element_id, occurrence);

-- ---------------------------------------------------------------------------
-- message_subscriptions — a Receive Task inside a loop re-subscribes per visit
-- (design §5). The broker key (workspace + messageName + correlationKey) is
-- unchanged; occurrence only keys the subscription row to its iteration.
-- ---------------------------------------------------------------------------
ALTER TABLE message_subscriptions ADD COLUMN occurrence INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- bpmn_elements — conditional topology (design §4): a sequenceFlow leaving an
-- exclusiveGateway carries its FEEL conditionExpression (document order =
-- evaluation order) or the gateway's `default` marker. NULL/0 on all other rows.
-- ---------------------------------------------------------------------------
ALTER TABLE bpmn_elements ADD COLUMN condition_expression TEXT;
ALTER TABLE bpmn_elements ADD COLUMN is_default           INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- gateway_decisions — every XOR branch decision, persisted atomically with the
-- transition (design §6, persist-before-advance). An existing row for
-- (instance, gateway, occurrence) is REUSED, never re-evaluated — crash/replay
-- takes the recorded branch in both execution modes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_decisions (
  decision_id        TEXT PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  element_id         TEXT NOT NULL,     -- the exclusiveGateway
  occurrence         INTEGER NOT NULL,
  chosen_flow_id     TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  evaluations        TEXT NOT NULL,     -- JSON [{flowId, expression, result}] in document order
  variables_snapshot TEXT,              -- evaluation context; size-capped by the payload limit
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_decisions
  ON gateway_decisions (instance_id, element_id, occurrence);

-- incidents.kind gains 'loopLimit' | 'noPath' (design §9). kind is an
-- unconstrained TEXT column (0002), so this is a contracts-level change only —
-- no schema delta needed here.
