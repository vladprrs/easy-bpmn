// FEEL condition engine — thin wrapper over `feelin` (M2 design §2 decision 1, §7).
//
// FEEL is the BPMN/DMN-ecosystem expression language (Camunda 8 semantics);
// feelin is a pure-JS interpreter (lezer grammar + luxon) with no eval /
// new Function, so it runs on Workers, and Camunda Modeler edits the
// expressions natively (canonicity/round-trip stays intact).
//
// Three entry points, two phases:
// - `parseCondition` — publish-time, syntax-only (no variable context exists at
//   publish). A failure yields the reason string for the validator's
//   element-id + reason ValidationIssueData contract (wired in TASK-33).
// - `parseFeelExpression` — publish-time, syntax-only, for VALUE-typed
//   expressions (M5-L3 MI cardinality/collection): the same lezer walk as
//   `parseCondition` minus the unary-test lint and the boolean-oriented wording.
// - `evaluateCondition` — runtime, against the instance's current variables
//   object (the same JSON the service-task input uses). The flow is taken ONLY
//   on boolean `true` — no truthy coercion. FEEL null-tolerance is preserved:
//   a missing variable makes comparisons null → not taken, NOT an error. A
//   hard interpreter failure throws ExpressionEvaluationError so gateway
//   dispatch (TASK-34) can raise a deterministic incident instead of silently
//   skipping the flow.

import { evaluate, parseExpression } from "feelin";

/** Cap on how much of an expression we echo back inside a reason/message. */
const SNIPPET_MAX_CHARS = 120;

export type ParseConditionResult = { ok: true } | { ok: false; reason: string };

/**
 * Outcome of evaluating one conditional sequence flow. `taken` is the strict
 * boolean-true contract; `value` (raw FEEL result) and `warnings` (interpreter
 * diagnostics such as "Variable 'amount' not found") feed the
 * `gatewayDecisionEvaluated` history diagnostics (design §6).
 */
export interface ConditionEvaluation {
  /** True only when the expression evaluated to boolean `true`. */
  taken: boolean;
  /**
   * The raw FEEL result (null when e.g. a referenced variable is missing).
   * May be a non-JSON-primitive FEEL object — pass it through
   * `normalizeFeelValue` before persisting.
   */
  value: unknown;
  /** Human-readable interpreter warnings; empty on a clean evaluation. */
  warnings: string[];
}

/**
 * JSON-safe normalization of a raw FEEL result (`ConditionEvaluation.value`)
 * before persisting it (gateway_decisions.evaluations, history diagnostics):
 * feelin can return non-JSON values (Range, luxon DateTime, functions).
 *
 * THE canonical normalization contract — other docstrings point here:
 * booleans, strings, and finite numbers pass through; FEEL null (e.g. a
 * missing variable) stays null; non-finite numbers become their string form
 * ("NaN"/"Infinity"/"-Infinity"); everything else (Range / DateTime /
 * function / list / context) becomes a deterministic `[feel:<Type>]` string
 * tag. The boolean `taken`/`result` flag — not this raw value — is the
 * branch-selection contract.
 */
export function normalizeFeelValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "function") return "[feel:function]";
  const name = (value as object).constructor?.name ?? typeof value;
  return `[feel:${name}]`;
}

/**
 * A hard FEEL interpreter failure (e.g. the expression does not parse). NOT
 * thrown for FEEL-null outcomes — those are a regular not-taken result. The
 * engine maps this to a deterministic, operator-visible incident.
 */
export class ExpressionEvaluationError extends Error {
  readonly expression: string;

  constructor(expression: string, cause: unknown) {
    super(
      `FEEL condition ${JSON.stringify(snippet(expression))} failed to evaluate: ${causeMessage(cause)}`,
      { cause },
    );
    this.name = "ExpressionEvaluationError";
    this.expression = expression;
  }
}

/**
 * Publish-time syntax check. Never executes the expression (publish has no
 * variable context); it parses with the lezer FEEL grammar and scans the tree
 * for error nodes. On failure, `reason` is ready-made ValidationIssueData
 * material — the caller attaches the element id.
 *
 * Semantic lint (TASK-33): an expression whose TOP node is a FEEL *unary test*
 * ("> 100", '= "x"', "[1..10]" — DMN decision-table habits) parses fine but
 * evaluates to a range/test object, never boolean `true`, so as a flow
 * condition it can never be taken. Reject it with a how-to-fix hint. The check
 * is top-node only: comparisons/ranges INSIDE a full expression ("amount in
 * [1..10]") have a different top node and pass; a parenthesized unary test
 * escapes the lint and surfaces at runtime as a not-taken/diagnostic instead.
 */
export function parseCondition(expression: string): ParseConditionResult {
  if (expression.trim() === "") {
    return { ok: false, reason: "Condition expression is empty." };
  }
  try {
    const tree = parseExpression(expression, {}, undefined);
    let errorAt: number | null = null;
    tree.iterate({
      enter(node) {
        if (node.type.isError && errorAt === null) {
          errorAt = node.from;
        }
      },
    });
    if (errorAt !== null) {
      return {
        ok: false,
        reason:
          `Invalid FEEL condition: syntax error at position ${errorAt} ` +
          `in ${JSON.stringify(snippet(expression))}.`,
      };
    }
    if (tree.topNode.firstChild?.type.name === "SimplePositiveUnaryTest") {
      return {
        ok: false,
        reason:
          `Condition ${JSON.stringify(snippet(expression))} is FEEL unary-test syntax, ` +
          "which never evaluates to boolean true on a sequence flow. " +
          'Write a full comparison instead (e.g. "amount > 100").',
      };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason:
        `Invalid FEEL condition ${JSON.stringify(snippet(expression))}: ${causeMessage(cause)}`,
    };
  }
}

/**
 * Publish-time FEEL syntax check for value-typed expressions (MI cardinality /
 * collection etc. — M5-L3). Same lezer error-node walk as `parseCondition`,
 * WITHOUT the unary-test lint: these expressions produce a VALUE (number/list),
 * not a boolean flow decision, so unary-test shapes are not a modeling error
 * here. Never executes the expression (publish has no variable context).
 */
export function parseFeelExpression(expression: string): ParseConditionResult {
  if (expression.trim() === "") {
    return { ok: false, reason: "FEEL expression is empty." };
  }
  try {
    const tree = parseExpression(expression, {}, undefined);
    let errorAt: number | null = null;
    tree.iterate({
      enter(node) {
        if (node.type.isError && errorAt === null) {
          errorAt = node.from;
        }
      },
    });
    if (errorAt !== null) {
      return {
        ok: false,
        reason:
          `Invalid FEEL expression: syntax error at position ${errorAt} ` +
          `in ${JSON.stringify(snippet(expression))}.`,
      };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason:
        `Invalid FEEL expression ${JSON.stringify(snippet(expression))}: ${causeMessage(cause)}`,
    };
  }
}

/**
 * Runtime evaluation against the instance variables. Returns a normal result
 * for every FEEL-defined outcome (including null from missing variables);
 * throws ExpressionEvaluationError only on a hard interpreter failure.
 */
export function evaluateCondition(
  expression: string,
  variables: Record<string, unknown>,
): ConditionEvaluation {
  let value: unknown;
  let warnings: string[];
  try {
    const result = evaluate(expression, variables);
    value = result.value;
    warnings = result.warnings.map((w) => w.message);
  } catch (cause) {
    throw new ExpressionEvaluationError(expression, cause);
  }
  return { taken: value === true, value, warnings };
}

function snippet(expression: string): string {
  return expression.length > SNIPPET_MAX_CHARS
    ? `${expression.slice(0, SNIPPET_MAX_CHARS)}…`
    : expression;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
