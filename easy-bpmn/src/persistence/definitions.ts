// Drafts, immutable versions, and their extracted BPMN elements.

import { dbAll, dbBatch, dbFirst, dbRun, stmt } from "./db";
import { parseJson, toJson } from "../util";
import type { BpmnElement, Draft, DefinitionVersion, ValidationIssue } from "../contracts/api";
import type { ExecutionGraph, GraphElement } from "../bpmn/graph";

interface DraftRow {
  draft_id: string;
  workspace_id: string;
  name: string;
  bpmn_xml: string;
  status: string;
  validation_issues: string;
  latest_published_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  definition_version_id: string;
  draft_id: string;
  workspace_id: string;
  version_number: number;
  bpmn_xml: string;
  bpmn_xml_hash: string;
  parsed_profile: string;
  status: string;
  published_at: string;
}

export function mapDraft(row: DraftRow): Draft {
  return {
    draftId: row.draft_id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status as Draft["status"],
    validationIssues: parseJson<ValidationIssue[]>(row.validation_issues, []),
    latestPublishedVersionId: row.latest_published_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createDraft(
  db: D1Database,
  input: {
    draftId: string;
    workspaceId: string;
    name: string;
    bpmnXml: string;
    status: Draft["status"];
    validationIssues: ValidationIssue[];
    now: string;
  },
): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO drafts
       (draft_id, workspace_id, name, bpmn_xml, status, validation_issues, latest_published_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      input.draftId,
      input.workspaceId,
      input.name,
      input.bpmnXml,
      input.status,
      toJson(input.validationIssues),
      input.now,
      input.now,
    ],
  );
}

export async function getDraftRow(db: D1Database, draftId: string): Promise<DraftRow | null> {
  return dbFirst<DraftRow>(db, `SELECT * FROM drafts WHERE draft_id = ?`, [draftId]);
}

export async function getDraft(db: D1Database, draftId: string): Promise<Draft | null> {
  const row = await getDraftRow(db, draftId);
  return row ? mapDraft(row) : null;
}

export async function setDraftLatestVersion(
  db: D1Database,
  draftId: string,
  versionId: string,
  now: string,
): Promise<void> {
  await dbRun(
    db,
    `UPDATE drafts SET latest_published_version_id = ?, updated_at = ? WHERE draft_id = ?`,
    [versionId, now, draftId],
  );
}

export async function nextVersionNumber(db: D1Database, draftId: string): Promise<number> {
  const row = await dbFirst<{ n: number | null }>(
    db,
    `SELECT MAX(version_number) AS n FROM definition_versions WHERE draft_id = ?`,
    [draftId],
  );
  return (row?.n ?? 0) + 1;
}

export async function createVersion(
  db: D1Database,
  input: {
    definitionVersionId: string;
    draftId: string;
    workspaceId: string;
    versionNumber: number;
    bpmnXml: string;
    bpmnXmlHash: string;
    graph: ExecutionGraph;
    now: string;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    stmt(
      db,
      `INSERT INTO definition_versions
         (definition_version_id, draft_id, workspace_id, version_number, bpmn_xml, bpmn_xml_hash, parsed_profile, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
      [
        input.definitionVersionId,
        input.draftId,
        input.workspaceId,
        input.versionNumber,
        input.bpmnXml,
        input.bpmnXmlHash,
        toJson(input.graph),
        input.now,
      ],
    ),
  ];
  for (const el of input.graph.elements) {
    statements.push(
      stmt(
        db,
        `INSERT INTO bpmn_elements
           (definition_version_id, element_id, type, name, task_type, message_name, retries, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.definitionVersionId,
          el.elementId,
          el.type,
          el.name ?? null,
          el.taskType ?? null,
          el.messageName ?? null,
          el.retries ?? null,
        ],
      ),
    );
  }
  await dbBatch(db, statements);
}

export async function getVersionRow(
  db: D1Database,
  versionId: string,
): Promise<VersionRow | null> {
  return dbFirst<VersionRow>(
    db,
    `SELECT * FROM definition_versions WHERE definition_version_id = ?`,
    [versionId],
  );
}

export async function getVersionGraph(
  db: D1Database,
  versionId: string,
): Promise<ExecutionGraph | null> {
  const row = await getVersionRow(db, versionId);
  if (!row) return null;
  return parseJson<ExecutionGraph | null>(row.parsed_profile, null);
}

export async function getVersionElements(
  db: D1Database,
  versionId: string,
): Promise<BpmnElement[]> {
  const rows = await dbAll<{
    element_id: string;
    type: string;
    name: string | null;
    task_type: string | null;
    message_name: string | null;
  }>(
    db,
    `SELECT element_id, type, name, task_type, message_name
       FROM bpmn_elements WHERE definition_version_id = ?`,
    [versionId],
  );
  return rows.map((r) => ({
    elementId: r.element_id,
    type: r.type as GraphElement["type"],
    name: r.name,
    taskType: r.task_type,
    messageName: r.message_name,
  }));
}

export async function mapVersion(
  db: D1Database,
  row: VersionRow,
): Promise<DefinitionVersion> {
  return {
    definitionVersionId: row.definition_version_id,
    draftId: row.draft_id,
    workspaceId: row.workspace_id,
    versionNumber: row.version_number,
    status: "published",
    bpmnXmlHash: row.bpmn_xml_hash,
    elements: await getVersionElements(db, row.definition_version_id),
    publishedAt: row.published_at,
  };
}
