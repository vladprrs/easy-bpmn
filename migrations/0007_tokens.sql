-- Token frontier (M4-L2) — additive D1 deltas over 0006_timers.sql.
--
-- execution_tokens is a DENORMALISED READ-MODEL: position_element_id + status are
-- recomputed by the deterministic rewalk each drive (operator inspection +
-- compensation cohort capture); they are NEVER read as a replay-decision input.
-- variables_overlay is authoritative mutable branch state, made idempotent by the
-- existing output_applied marker exactly like process_instances.variables.
--
-- join_arrivals / join_completions are the APPEND-ONLY join facts (the real replay
-- predicates): arrival via INSERT OR IGNORE (duplicate = no-op), completion via a
-- PLAIN INSERT composed into the advance batch (the gateway_decisions race
-- discipline — a losing concurrent batch aborts wholesale on the PK and re-reads).
--
-- CREATE … IF NOT EXISTS / additive ALTER, matching the 0004/0006 convention so a
-- partial/re-applied run is a no-op.

CREATE TABLE IF NOT EXISTS execution_tokens (
  token_id            TEXT PRIMARY KEY,                 -- root: '<inst>:#root'; branch: '<inst>:<split>#<activation>:<branchFlow>'
  instance_id         TEXT NOT NULL,
  region_id           TEXT,                             -- enclosing split id; NULL for root
  region_activation   INTEGER NOT NULL DEFAULT 0,       -- split's walk-local occurrence; 0 for root
  parent_token_id     TEXT,                             -- token consumed at the split; NULL for root
  branch_flow_id      TEXT,                             -- split out-flow taken; NULL for root/produced
  position_element_id TEXT NOT NULL,                    -- DERIVED read-model; not a replay input
  status              TEXT NOT NULL DEFAULT 'active',   -- active|waiting|arrivedAtJoin|consumed|merged|discarded
  variables_overlay   TEXT NOT NULL DEFAULT '{}',       -- JSON delta over parent; or {"__r2":"<key>"}
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_instance_status ON execution_tokens (instance_id, status);
CREATE INDEX IF NOT EXISTS idx_tokens_region          ON execution_tokens (instance_id, region_id, region_activation, status);

CREATE TABLE IF NOT EXISTS join_arrivals (
  instance_id    TEXT NOT NULL,
  join_id        TEXT NOT NULL,
  activation     INTEGER NOT NULL,
  branch_flow_id TEXT NOT NULL,
  arrived_at     TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation, branch_flow_id)             -- INSERT OR IGNORE
);

CREATE TABLE IF NOT EXISTS join_completions (
  instance_id       TEXT NOT NULL,
  join_id           TEXT NOT NULL,
  activation        INTEGER NOT NULL,
  produced_token_id TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (instance_id, join_id, activation)                            -- PLAIN INSERT in the advance batch
);

-- Inclusive-split activation set (single chosen_flow_id cannot represent a subset).
ALTER TABLE gateway_decisions ADD COLUMN activated_flow_ids TEXT;            -- JSON array, document order; NULL for XOR/EBG/parallel

-- The branch token that produced a ledger row (M4-L5, design §8.4): NULL on the
-- single-token (M1-M3 / root) path. The lineage-quiescence-ordered reverse pass
-- uses it to compensate a step only once its branch lineage has no live token.
ALTER TABLE saga_steps ADD COLUMN token_id TEXT;
