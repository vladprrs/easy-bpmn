-- M5-L3 multiInstanceLoopCharacteristics (design §6) — the mi_activations decider
-- table (the gateway_decisions analogue: cardinality pinned ONCE at activation, then
-- the early-settle + apply-once CAS deciders) plus the iteration_index SECOND
-- dimension on service_task_jobs + saga_steps. Every pre-L3 path is a pure NO-OP:
-- the new column DEFAULTs to 0, and the widened unique indexes keep the OLD key
-- columns in their original order (so existing lookups stay index-served) with
-- iteration_index appended last.

CREATE TABLE IF NOT EXISTS mi_activations (
  instance_id     TEXT    NOT NULL,
  element_id      TEXT    NOT NULL,            -- the MI activity node id
  occurrence      INTEGER NOT NULL,
  cardinality     INTEGER NOT NULL,            -- pinned once at activation (the decider seed)
  is_sequential   INTEGER NOT NULL,            -- 0 = parallel, 1 = sequential
  items           TEXT,                        -- JSON of the resolved collection, or NULL (loopCardinality)
  settled_kind    TEXT,                        -- NULL = running | all | condition | abort (the once-only early-settle decider)
  settled_count   INTEGER,
  output_applied  INTEGER NOT NULL DEFAULT 0,  -- single-apply CAS for the aggregation merge
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mi_activations_visit
  ON mi_activations (instance_id, element_id, occurrence);

-- The iteration_index second dimension: an MI activity fans one (element, occurrence)
-- visit into `cardinality` iterations, each its own forward job / ledger step. Non-MI
-- writes stay 0 everywhere (DEFAULT 0), so this is invisible to M1–M5-L2 paths.
ALTER TABLE service_task_jobs ADD COLUMN iteration_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saga_steps        ADD COLUMN iteration_index INTEGER NOT NULL DEFAULT 0;

-- Widen the two forward-key unique indexes with iteration_index. The OLD key columns
-- keep their exact prior order so every existing lookup (occurrence-keyed and the
-- element-prefix scans) stays index-served; iteration_index is appended last.
DROP INDEX IF EXISTS uq_jobs_instance_element_kind;
CREATE UNIQUE INDEX uq_jobs_instance_element_kind
  ON service_task_jobs (instance_id, element_id, is_compensation, occurrence, iteration_index);
DROP INDEX IF EXISTS uq_saga_steps_forward;
CREATE UNIQUE INDEX uq_saga_steps_forward
  ON saga_steps (instance_id, element_id, occurrence, iteration_index);
