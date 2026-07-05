-- M5-L2 callActivity (spec §2) — the child-idempotency provenance table + parent
-- linkage. child_instances is the rewalk fast-forward predicate gating BOTH the
-- child Workflow create and the output apply (the analogue of gateway_decisions /
-- output_applied=1); the UNIQUE index is the at-least-once single-apply guard.

CREATE TABLE IF NOT EXISTS child_instances (
  parent_instance_id TEXT    NOT NULL,
  parent_element_id  TEXT    NOT NULL,            -- the callActivity node id
  occurrence         INTEGER NOT NULL,
  iteration_index    INTEGER NOT NULL DEFAULT 0,  -- reserved for M5-L3 MI
  child_instance_id  TEXT    NOT NULL,
  status             TEXT    NOT NULL,            -- invoked | outputApplied
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_child_instances_visit
  ON child_instances (parent_instance_id, parent_element_id, occurrence, iteration_index);
CREATE INDEX IF NOT EXISTS idx_child_instances_child ON child_instances (child_instance_id);

-- Parent linkage on the child row (NULL for root instances) + the child-only
-- errored terminal's business error code (spec §4).
ALTER TABLE process_instances ADD COLUMN parent_instance_id TEXT;
ALTER TABLE process_instances ADD COLUMN parent_element_id  TEXT;
ALTER TABLE process_instances ADD COLUMN parent_occurrence  INTEGER;
ALTER TABLE process_instances ADD COLUMN error_code         TEXT;
CREATE INDEX IF NOT EXISTS idx_instances_parent ON process_instances (parent_instance_id);

-- Step-kind dispatch for the reverse pass (spec §5): NULL = worker-task step;
-- non-NULL = compensate by driving this child instance's own reverse pass.
ALTER TABLE saga_steps ADD COLUMN child_instance_id TEXT;
