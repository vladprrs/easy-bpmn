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
-- Predicate: "this job's output was applied" — decided PER JOB via the
-- variable_snapshots row that M1's applyForwardCompletion wrote in the SAME
-- dbBatch as the variable merge + advance, with source='serviceTask' and
-- source_id=<job_id>. That row exists if and only if the apply committed:
--   * It was UNCONDITIONAL — written even when the worker output was empty
--     (M1 parsed output_variables with a `{}` default and inserted the
--     snapshot regardless), so empty-output applied jobs are still matched.
--   * The M1 poison paths returned BEFORE the apply batch (below-threshold
--     rejection re-opened the job; at-threshold went straight to a
--     kind='poison' incident), so a poison-completed job has NO snapshot,
--     stays output_applied=0, and an operator /retry re-runs the step
--     instead of fast-forwarding past it.
--   * The crash/lost-sendEvent window (worker /jobs/complete committed but
--     the drive never applied — in workflow mode this state can persist up
--     to the 1h waitForEvent timeout) also has NO snapshot, so the rewalk
--     applies the output instead of silently dropping it forever.
--   * Compensation completions never wrote variable snapshots (their
--     "applied" state lives in saga_steps.compensation_status), and
--     is_compensation = 0 excludes them anyway.
--
-- Deliberately NOT keyed on process_instances.status: an instance can sit in
-- 'incident' with EARLIER applied steps — those must be marked applied (or a
-- post-/retry rewalk re-applies them), while the incident step's own
-- unapplied completion (poison) must stay 0. Both fall out of the per-job
-- snapshot check.
UPDATE service_task_jobs
   SET output_applied = 1
 WHERE status = 'completed'
   AND is_compensation = 0
   AND output_applied = 0
   AND EXISTS (
     SELECT 1
       FROM variable_snapshots vs
      WHERE vs.instance_id = service_task_jobs.instance_id
        AND vs.source = 'serviceTask'
        AND vs.source_id = service_task_jobs.job_id
   );
