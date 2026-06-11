-- TASK-32 live-migration backfill — one-time data fix over 0004_conditional.sql.
--
-- 0004 added `output_applied` with DEFAULT 0, so every job COMPLETED AND
-- APPLIED under the pre-rewalk (M1) engine still carries output_applied = 0.
-- The TASK-32 engine re-walks from the start element and uses output_applied
-- as the write-free fast-forward predicate; without this backfill, the FIRST
-- post-deploy resume/replay of an in-flight M1 instance would treat every
-- previously applied Service Task as the resume frontier and RE-APPLY it —
-- duplicating serviceTaskCompleted history / variable snapshots and re-merging
-- old outputs over newer variables.
--
-- M1's persist-before-advance contract means a completed forward job on a
-- non-incident instance has ALWAYS had its output applied (the apply and the
-- advance commit in one batch; the only completed-but-unapplied state is the
-- sub-second crash window between a worker callback and its drive). Instances
-- in `incident` are EXCLUDED: a poison incident (kind='poison') is exactly a
-- completed job whose output was NEVER applicable — marking it applied would
-- make an operator /retry fast-forward past the step instead of re-running it.
--
-- Compensation jobs are untouched: their "applied" state lives in the saga
-- ledger (saga_steps.compensation_status), never in output_applied.
UPDATE service_task_jobs
   SET output_applied = 1
 WHERE status = 'completed'
   AND is_compensation = 0
   AND output_applied = 0
   AND instance_id IN (
     SELECT instance_id FROM process_instances WHERE status != 'incident'
   );
