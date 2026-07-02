// Publish-time callActivity resolution (M5-L2, spec §7). Runs at the CALLER's
// publish, after the pure validator accepted the document: binds every
// callActivity to the latest published version of its target process in the
// same workspace (Principle II), then walks the RESOLVED call tree (stored
// child graphs already carry their own resolved ids — the tree is an immutable
// DAG) enforcing MAX_CALL_DEPTH, a defensive cycle check, and the v1 reject of
// message waits anywhere in the tree.
import type { ExecutionGraph, ValidationIssueData } from "./graph";
import { MAX_CALL_DEPTH } from "../runtime/engine";
import { dbFirst } from "../persistence/db";

interface VersionHit {
  definition_version_id: string;
  parsed_profile: string;
}

async function latestVersionByProcessId(
  db: D1Database,
  workspaceId: string,
  processId: string,
): Promise<VersionHit | null> {
  return dbFirst<VersionHit>(
    db,
    `SELECT definition_version_id, parsed_profile FROM definition_versions
      WHERE workspace_id = ? AND json_extract(parsed_profile, '$.processId') = ?
      ORDER BY published_at DESC, definition_version_id DESC LIMIT 1`,
    [workspaceId, processId],
  );
}

function callNodes(graph: ExecutionGraph): Array<{ id: string; node: ExecutionGraph["nodes"][string] }> {
  return Object.entries(graph.nodes)
    .filter(([, n]) => n.type === "callActivity")
    .map(([id, node]) => ({ id, node }));
}

function messageWaitIds(graph: ExecutionGraph): string[] {
  return Object.entries(graph.nodes)
    .filter(([, n]) => n.type === "receiveTask" || (n.type === "intermediateCatchEvent" && n.messageName))
    .map(([id]) => id);
}

export async function resolveCallActivities(
  db: D1Database,
  workspaceId: string,
  graph: ExecutionGraph,
): Promise<{ ok: boolean; issues: ValidationIssueData[] }> {
  const issues: ValidationIssueData[] = [];
  const calls = callNodes(graph);
  if (calls.length === 0) return { ok: true, issues };

  const err = (elementId: string, reason: string) =>
    issues.push({ severity: "error", elementId, elementName: elementId, reason });

  // 1. Bind each direct call to the latest published child version.
  const childGraphs = new Map<string, ExecutionGraph>(); // versionId → graph
  for (const { id, node } of calls) {
    const hit = await latestVersionByProcessId(db, workspaceId, node.calledElementId!);
    if (!hit) {
      err(id, `Call activity '${id}' calledElement '${node.calledElementId}' does not resolve to any published process in this workspace.`);
      continue;
    }
    node.calledDefinitionVersionId = hit.definition_version_id;
    childGraphs.set(hit.definition_version_id, JSON.parse(hit.parsed_profile) as ExecutionGraph);
  }
  if (issues.length > 0) return { ok: false, issues };

  // 2. Walk the resolved tree: depth, defensive cycles, v1 message-wait reject.
  //    depthOf(g) = 1 + max(depthOf(child)); memoized by versionId.
  const depthMemo = new Map<string, number>();
  const walk = async (g: ExecutionGraph, versionId: string | null, chain: string[], viaCallId: string): Promise<number> => {
    if (versionId && chain.includes(versionId)) {
      err(viaCallId, `Call activity '${viaCallId}' creates a call cycle (${[...chain, versionId].join(" -> ")}).`);
      return 1;
    }
    if (versionId && depthMemo.has(versionId)) return depthMemo.get(versionId)!;
    for (const m of messageWaitIds(g)) {
      err(viaCallId, `Called process contains a message wait ('${m}') — a callActivity child has no correlation-key source; message waits anywhere in the call tree are rejected in this layer (spec §7).`);
    }
    let max = 0;
    for (const { id, node } of callNodes(g)) {
      const childVid = node.calledDefinitionVersionId!;
      let childGraph = childGraphs.get(childVid);
      if (!childGraph) {
        const row = await dbFirst<VersionHit>(
          db,
          `SELECT definition_version_id, parsed_profile FROM definition_versions WHERE definition_version_id = ?`,
          [childVid],
        );
        if (!row) {
          err(id, `Call activity '${id}' pinned child version '${childVid}' is missing.`);
          continue;
        }
        childGraph = JSON.parse(row.parsed_profile) as ExecutionGraph;
        childGraphs.set(childVid, childGraph);
      }
      max = Math.max(max, await walk(childGraph, childVid, versionId ? [...chain, versionId] : chain, id));
    }
    const d = 1 + max;
    if (versionId) depthMemo.set(versionId, d);
    return d;
  };
  let depth = 0;
  for (const { id, node } of calls) {
    const g = childGraphs.get(node.calledDefinitionVersionId!)!;
    depth = Math.max(depth, 1 + (await walk(g, node.calledDefinitionVersionId!, [], id)));
    if (depth > MAX_CALL_DEPTH) {
      err(id, `Call tree depth ${depth} exceeds MAX_CALL_DEPTH = ${MAX_CALL_DEPTH}.`);
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}
