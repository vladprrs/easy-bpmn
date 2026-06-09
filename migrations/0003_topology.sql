-- Queryable topology (TASK-11 closeout, design §3.2) — additive D1 deltas over
-- 0002_saga.sql. Sequence-flow and compensation-association wiring was dropped at
-- publish (validator emitted bare element rows; definitions.ts persisted no refs),
-- leaving topology non-queryable and replay only via the parsed_profile JSON. This
-- migration stops the drop: bpmn_elements rows for `sequenceFlow` carry
-- source_ref/target_ref and `association` rows carry source/target (boundaryId →
-- isForCompensation handler).
--
-- Additive + idempotent: an ALTER TABLE ... ADD COLUMN applies exactly once
-- (tracked by the migration runner) and never mutates a published version's rows.
-- 0003 follows 0002 (saga ledger) so the sequence number does not collide.

ALTER TABLE bpmn_elements ADD COLUMN source_ref TEXT;   -- sequenceFlow.sourceRef / association.sourceRef
ALTER TABLE bpmn_elements ADD COLUMN target_ref TEXT;   -- sequenceFlow.targetRef / association.targetRef
