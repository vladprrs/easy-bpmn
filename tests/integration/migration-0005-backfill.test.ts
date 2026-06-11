import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Data gate for migration 0005_output_applied_backfill.sql — the one-time
// live-migration that marks deployed-M1 jobs as output_applied=1 so the
// TASK-32 rewalk fast-forwards them write-free.
//
// The predicate is PER JOB: M1's applyForwardCompletion wrote a
// variable_snapshots row (source='serviceTask', source_id=<job_id>) in the
// SAME dbBatch as the variable merge + advance — unconditionally, even for
// empty worker output. That row is the witness that the apply committed:
//   * completed + snapshot        → applied      → backfill marks it;
//   * completed + NO snapshot     → the M1 crash / lost-sendEvent window
//     (worker /jobs/complete committed, drive never applied) or a poison
//     completion → must stay 0 so the rewalk applies (or /retry re-runs) it;
//   * instance status is IRRELEVANT — an 'incident' instance keeps its
//     EARLIER applied steps marked (or a post-/retry rewalk would re-apply
//     them) while the incident step's own unapplied completion stays 0.
//
// The setup file already ran 0005 against the empty test DB; here we insert
// M1-shaped fixtures with the REAL statement builders and re-execute the
// migration's own SQL (pinned from env.TEST_MIGRATIONS, i.e. the file on
// disk) to prove the predicate.

import {
  createJobStmt,
  jobCompleteStmt,
  variableSnapshotStmt,
} from "../../src/persistence/instances";

const NOW = "2026-06-10T00:00:00Z";

interface D1Migration {
  name: string;
  queries: string[];
}

async function runBackfill(): Promise<void> {
  const migrations = env.TEST_MIGRATIONS as unknown as D1Migration[];
  const backfill = migrations.find((m) => m.name.startsWith("0005"));
  expect(backfill, "migration 0005 must be on disk").toBeDefined();
  for (const query of backfill!.queries) {
    await env.DB.prepare(query).run();
  }
}

function insertJob(jobId: string, instanceId: string, elementId: string, isComp = false) {
  return createJobStmt(env.DB, {
    jobId,
    instanceId,
    elementId,
    taskType: "reserve-stock",
    retryLimit: 3,
    idempotencyKey: `${instanceId}:${elementId}:${isComp ? 1 : 0}:0`,
    inputVariables: { sku: "A" },
    now: NOW,
    isCompensation: isComp,
    occurrence: 0,
  }).run();
}

/** M1 apply witness: the snapshot row applyForwardCompletion batched with the advance. */
function insertApplySnapshot(instanceId: string, jobId: string, variables: Record<string, unknown> = { ok: true }) {
  return variableSnapshotStmt(env.DB, {
    instanceId,
    source: "serviceTask",
    sourceId: jobId,
    variables,
    now: NOW,
  }).run();
}

function insertInstance(instanceId: string, status: string) {
  return env.DB.prepare(
    `INSERT INTO process_instances
       (instance_id, workspace_id, definition_version_id, workflow_instance_id, correlation_key, status, variables, started_at, updated_at)
     VALUES (?, 'ws1', 'ver1', ?, 'ck-1', ?, '{}', ?, ?)`,
  )
    .bind(instanceId, `wf_${instanceId}`, status, NOW, NOW)
    .run();
}

async function outputApplied(jobId: string): Promise<number | undefined> {
  const row = await env.DB.prepare(`SELECT output_applied FROM service_task_jobs WHERE job_id = ?`)
    .bind(jobId)
    .first<{ output_applied: number }>();
  return row?.output_applied;
}

describe("migration 0005 backfill predicate (per-job apply witness)", () => {
  it("marks applied jobs and ONLY applied jobs — independent of instance status", async () => {
    // (1) plainly applied M1 job on a waiting instance → marked
    await insertInstance("pi_bf_applied", "waiting");
    await insertJob("job_bf_applied", "pi_bf_applied", "taskA");
    await jobCompleteStmt(env.DB, "job_bf_applied", { reserved: true }, NOW).run();
    await insertApplySnapshot("pi_bf_applied", "job_bf_applied", { reserved: true });

    // (2) completed-but-UNAPPLIED window (worker /complete committed, drive
    // never applied — no snapshot) on a NON-incident instance → must stay 0;
    // the old `status != 'incident'` predicate wrongly marked exactly this row
    // and silently dropped the worker output forever.
    await insertInstance("pi_bf_window", "waiting");
    await insertJob("job_bf_window", "pi_bf_window", "taskA");
    await jobCompleteStmt(env.DB, "job_bf_window", { lost: "output" }, NOW).run();

    // (3) incident instance: the EARLIER applied step → marked (the old
    // per-instance exclusion left it 0 → post-/retry rewalk re-applied it);
    // the incident step's own poison completion (no snapshot) → stays 0 so
    // /retry re-runs it.
    await insertInstance("pi_bf_incident", "incident");
    await insertJob("job_bf_early", "pi_bf_incident", "taskA");
    await jobCompleteStmt(env.DB, "job_bf_early", { step: 1 }, NOW).run();
    await insertApplySnapshot("pi_bf_incident", "job_bf_early", { step: 1 });
    await insertJob("job_bf_poison", "pi_bf_incident", "taskB");
    await jobCompleteStmt(env.DB, "job_bf_poison", { huge: "blob" }, NOW).run();

    await runBackfill();

    expect(await outputApplied("job_bf_applied")).toBe(1);
    expect(await outputApplied("job_bf_window")).toBe(0);
    expect(await outputApplied("job_bf_early")).toBe(1);
    expect(await outputApplied("job_bf_poison")).toBe(0);

    // idempotent — a second run changes nothing
    await runBackfill();
    expect(await outputApplied("job_bf_window")).toBe(0);
    expect(await outputApplied("job_bf_poison")).toBe(0);
  });

  it("matches empty-output applied jobs — M1 wrote the snapshot row unconditionally", async () => {
    await insertInstance("pi_bf_empty", "completed");
    await insertJob("job_bf_empty", "pi_bf_empty", "taskA");
    // M1 parsed output_variables with a `{}` default and ALWAYS inserted the
    // snapshot in the apply batch — an applied empty-output job has a witness.
    await jobCompleteStmt(env.DB, "job_bf_empty", {}, NOW).run();
    await insertApplySnapshot("pi_bf_empty", "job_bf_empty", {});

    await runBackfill();
    expect(await outputApplied("job_bf_empty")).toBe(1);
  });

  it("never touches compensation rows, non-serviceTask snapshots, or non-completed jobs", async () => {
    await insertInstance("pi_bf_neg", "waiting");

    // completed COMPENSATION job — its applied state lives in saga_steps,
    // never in output_applied
    await insertJob("job_bf_comp", "pi_bf_neg", "taskA", true);
    await jobCompleteStmt(env.DB, "job_bf_comp", { released: true }, NOW).run();

    // completed forward job whose only snapshot is a MESSAGE apply that
    // happens to share the id — the source filter must not count it
    await insertJob("job_bf_msgsrc", "pi_bf_neg", "taskB");
    await jobCompleteStmt(env.DB, "job_bf_msgsrc", { x: 1 }, NOW).run();
    await variableSnapshotStmt(env.DB, {
      instanceId: "pi_bf_neg",
      source: "message",
      sourceId: "job_bf_msgsrc",
      variables: { x: 1 },
      now: NOW,
    }).run();

    // non-completed job — even with a (impossible-in-M1) snapshot witness the
    // status guard keeps it untouched
    await insertJob("job_bf_created", "pi_bf_neg", "taskC");
    await insertApplySnapshot("pi_bf_neg", "job_bf_created");

    await runBackfill();
    expect(await outputApplied("job_bf_comp")).toBe(0);
    expect(await outputApplied("job_bf_msgsrc")).toBe(0);
    expect(await outputApplied("job_bf_created")).toBe(0);
  });
});
