-- Model-level timers (M3-L3) — additive D1 deltas over 0005_output_applied_backfill.sql.
--
-- Storage substrate for the M3 time-&-failure-taxonomy timer set (design
-- 2026-06-11 §4.1/§4.2/§4.3): interrupting boundary timers, timer/message
-- intermediate catch, and the eventBasedGateway timer branch. No runtime
-- behavior lives here — the arm/fire/decider runtime is the persistence builders
-- in src/persistence/timers.ts plus the Scheduler DO + fireTimer seam.
--
-- Migrations are applied exactly once (tracked by the migration runner); the
-- CREATE statements still use IF NOT EXISTS for belt-and-braces (the 0004
-- convention), so a partial/re-applied run is a no-op rather than an error.
--
-- `fire_at` is computed ONCE at arm time IN CODE (timeDate as-is; now +
-- timeDuration) and snapshotted here — never recomputed in SQL — so a rewalk
-- re-park and a Workflow replay both see the same deadline (replay-safety, and
-- the foundation for later FEEL-expression triggers; design §4.1/§11).

-- ---------------------------------------------------------------------------
-- timers — the canonical, queryable source of record for one armed model timer
-- (design §4.1). The PK is DETERMINISTIC: `instanceId:elementId#occurrence`,
-- where `occurrence` is the ARMING visit's occurrence (the host activity's visit
-- for a boundary timer, the catch's own visit for an intermediate catch, the
-- gateway's visit for an eventBasedGateway timer branch) — NEVER derived from
-- live D1 row counts (the M2 rewalk rule). `status` is bookkeeping / read-model
-- only (the authoritative race outcome lives in timer_outcomes for boundary /
-- intermediateCatch timers, and in gateway_decisions for eventGateway timers,
-- §4.1/§4.5). Arming is INSERT OR IGNORE, so a rewalk that revisits an `armed`
-- row is a write-free re-park.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timers (
  timer_id        TEXT PRIMARY KEY,   -- deterministic: instanceId:elementId#occurrence
  instance_id     TEXT NOT NULL,
  element_id      TEXT NOT NULL,      -- the timer-event element (boundary | catch | EBG branch)
  occurrence      INTEGER NOT NULL,   -- the arming visit's occurrence
  kind            TEXT NOT NULL,      -- boundary | intermediateCatch | eventGateway
  attached_to_ref TEXT,               -- boundary: host activity element id
  gateway_id      TEXT,               -- eventGateway: owning gateway element id
  fire_at         TEXT NOT NULL,      -- computed at arm time (timeDate as-is; now + timeDuration)
  status          TEXT NOT NULL,      -- armed | fired | cancelled  (bookkeeping/read model, §4.3)
  fired_at        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timers_visit
  ON timers (instance_id, element_id, occurrence);
CREATE INDEX IF NOT EXISTS idx_timers_instance_status
  ON timers (instance_id, status);

-- ---------------------------------------------------------------------------
-- timer_outcomes — the RACE DECIDER for boundary / intermediateCatch timers
-- (design §4.1/§4.3/§4.5). Exactly one row per timer, claimed by a PLAIN INSERT
-- (NEVER `OR IGNORE`) composed into the SAME dbBatch as the loser-visible
-- transition, so a competing batch ABORTS WHOLESALE on this PK violation and the
-- loser converts to the recorded outcome on re-read — the documented
-- gateway_decisions contract (src/persistence/gateway-decisions.ts:70-84).
--
-- eventBasedGateway timers decide on gateway_decisions instead and get NO
-- timer_outcomes row (the EBG's sole decider is its gateway_decisions row,
-- §4.5); this table is modeled now, the EBG wiring lands in TASK-46.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timer_outcomes (
  timer_id   TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL,           -- fired | cancelled
  decided_at TEXT NOT NULL
);
