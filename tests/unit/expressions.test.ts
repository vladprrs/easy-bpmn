import { describe, expect, it } from "vitest";
import {
  ExpressionEvaluationError,
  evaluateCondition,
  parseCondition,
} from "../../src/runtime/expressions";

// TASK-30 (M2 design §7): feelin-backed FEEL condition engine. Publish-time
// parse is syntax-only (no variable context exists at publish); runtime
// evaluation takes a flow ONLY on boolean `true` (no truthy coercion), keeps
// FEEL null-tolerance (missing variable → comparisons null → not taken, not an
// error), and surfaces hard interpreter errors as a dedicated typed throw so
// gateway dispatch can raise a deterministic incident (design §10 scenario 9).

describe("parseCondition (publish-time syntax check)", () => {
  it("accepts well-formed FEEL conditions", () => {
    const valid = [
      "amount > 100",
      'status = "approved"',
      "amount in [100..200]",
      "amount between 100 and 200",
      'starts with(name, "Jo")',
      "approved and (amount > 100 or override)",
      "not(rejected)",
      "true",
    ];
    for (const expr of valid) {
      expect(parseCondition(expr), expr).toEqual({ ok: true });
    }
  });

  it("rejects invalid FEEL with a reason string usable for a validation issue", () => {
    const invalid = ["amount >", "1 +* 2", "amount in [100..", ") nonsense ("];
    for (const expr of invalid) {
      const result = parseCondition(expr);
      expect(result.ok, expr).toBe(false);
      if (!result.ok) {
        // The reason is the validator's ValidationIssueData.reason material:
        // human-readable, names the offending expression (element id is
        // attached by the validator caller — TASK-33).
        expect(result.reason).toBeTypeOf("string");
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.reason).toContain(expr);
      }
    }
  });

  it("reports the error position inside the expression when available", () => {
    const result = parseCondition("amount >");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/position 8/);
    }
  });

  it("rejects empty or whitespace-only expressions", () => {
    for (const expr of ["", "   ", "\n\t"]) {
      const result = parseCondition(expr);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/empty/i);
      }
    }
  });

  it("does not require a variable context — unknown names are a runtime concern", () => {
    // Publish-time has no instance variables; names that will only exist at
    // runtime must parse cleanly.
    expect(parseCondition("totallyUnknownVariable > someOtherUnknown")).toEqual({ ok: true });
  });

  // TASK-33 semantic lint: FEEL *unary-test* syntax ("> 100", '= "x"',
  // "[1..10]") parses fine as an expression but evaluates to a range/test —
  // never boolean `true` — so as a flow condition it can never be taken.
  // A classic modeler footgun (DMN habits); reject it at publish with a hint.
  it("rejects unary-test syntax that can never evaluate to boolean true", () => {
    for (const expr of ["> 100", ">= 10", '= "x"', '!= "x"', "< 5", "[1..10]"]) {
      const result = parseCondition(expr);
      expect(result.ok, expr).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/unary-test/i);
        // the hint shows how to fix it
        expect(result.reason).toMatch(/amount > 100|full comparison/i);
      }
    }
  });

  it("does not flag full expressions that merely CONTAIN comparison operators or ranges", () => {
    for (const expr of ["amount > 100", "amount in [1..10]", "x = 1 or y = 2", "true"]) {
      expect(parseCondition(expr), expr).toEqual({ ok: true });
    }
  });
});

describe("evaluateCondition (strict boolean-true contract)", () => {
  it("takes the flow only on boolean true — no truthy coercion", () => {
    expect(evaluateCondition("true", {}).taken).toBe(true);
    expect(evaluateCondition("false", {}).taken).toBe(false);
    // Truthy non-booleans are NOT taken (design §7).
    expect(evaluateCondition("1", {}).taken).toBe(false);
    expect(evaluateCondition('"x"', {}).taken).toBe(false);
    expect(evaluateCondition('"true"', {}).taken).toBe(false);
    expect(evaluateCondition("null", {}).taken).toBe(false);
    expect(evaluateCondition("[1, 2, 3]", {}).taken).toBe(false);
  });

  it("exposes the raw FEEL value for gateway-decision diagnostics", () => {
    expect(evaluateCondition("1 + 1", {}).value).toBe(2);
    expect(evaluateCondition("amount > 100", { amount: 250 }).value).toBe(true);
    expect(evaluateCondition("amount > 100", {}).value).toBe(null);
  });

  it("evaluates comparisons against the instance variables object", () => {
    expect(evaluateCondition("amount > 100", { amount: 250 }).taken).toBe(true);
    expect(evaluateCondition("amount > 100", { amount: 50 }).taken).toBe(false);
    expect(evaluateCondition("amount >= 100", { amount: 100 }).taken).toBe(true);
    expect(evaluateCondition("amount < 100", { amount: 50 }).taken).toBe(true);
  });

  it("evaluates equality", () => {
    expect(evaluateCondition('status = "approved"', { status: "approved" }).taken).toBe(true);
    expect(evaluateCondition('status = "approved"', { status: "rejected" }).taken).toBe(false);
    expect(evaluateCondition('status != "approved"', { status: "rejected" }).taken).toBe(true);
  });

  it("evaluates ranges", () => {
    expect(evaluateCondition("amount in [100..200]", { amount: 150 }).taken).toBe(true);
    expect(evaluateCondition("amount in [100..200]", { amount: 250 }).taken).toBe(false);
    expect(evaluateCondition("amount between 100 and 200", { amount: 150 }).taken).toBe(true);
    expect(evaluateCondition("amount between 100 and 200", { amount: 99 }).taken).toBe(false);
  });

  it("evaluates string operations", () => {
    expect(evaluateCondition('starts with(name, "Jo")', { name: "John" }).taken).toBe(true);
    expect(evaluateCondition('starts with(name, "Jo")', { name: "Bob" }).taken).toBe(false);
    expect(evaluateCondition('contains(name, "oh")', { name: "John" }).taken).toBe(true);
    expect(evaluateCondition('matches(code, "^[A-Z]{2}-\\d+$")', { code: "AB-42" }).taken).toBe(true);
  });

  it("evaluates boolean combinators over variables", () => {
    const vars = { approved: true, amount: 250 };
    expect(evaluateCondition("approved and amount > 100", vars).taken).toBe(true);
    expect(evaluateCondition("approved and amount > 1000", vars).taken).toBe(false);
    expect(evaluateCondition("not(approved)", vars).taken).toBe(false);
  });

  it("reads nested context entries like the service-task input JSON", () => {
    const vars = { order: { total: 250, customer: { vip: true } } };
    expect(evaluateCondition("order.total > 100", vars).taken).toBe(true);
    expect(evaluateCondition("order.customer.vip", vars).taken).toBe(true);
  });
});

describe("evaluateCondition (FEEL null-tolerance — missing variable is not an error)", () => {
  it("missing variable in a comparison → not taken, no throw", () => {
    const result = evaluateCondition("amount > 100", {});
    expect(result.taken).toBe(false);
    expect(result.value).toBe(null);
  });

  it("missing variable in an equality → not taken, no throw", () => {
    expect(evaluateCondition('status = "approved"', {}).taken).toBe(false);
  });

  it("missing variable in a range → not taken, no throw", () => {
    expect(evaluateCondition("amount in [100..200]", {}).taken).toBe(false);
    expect(evaluateCondition("amount between 100 and 200", {}).taken).toBe(false);
  });

  it("missing variable in a string operation → not taken, no throw", () => {
    expect(evaluateCondition('starts with(name, "Jo")', {}).taken).toBe(false);
    expect(evaluateCondition('contains(name, "oh")', {}).taken).toBe(false);
  });

  it("missing variable inside a compound expression → not taken, no throw", () => {
    expect(evaluateCondition("amount > 100 and ready", { ready: true }).taken).toBe(false);
  });

  it("missing nested property → not taken, no throw", () => {
    expect(evaluateCondition("order.total > 100", { order: {} }).taken).toBe(false);
    expect(evaluateCondition("order.total > 100", {}).taken).toBe(false);
  });

  it("surfaces interpreter warnings (e.g. variable not found) for diagnostics", () => {
    const result = evaluateCondition("amount > 100", {});
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("amount");
    // The happy path carries no warnings.
    expect(evaluateCondition("amount > 100", { amount: 250 }).warnings).toEqual([]);
  });
});

describe("evaluateCondition (hard interpreter error → deterministic incident material)", () => {
  it("throws ExpressionEvaluationError on a syntactically broken expression", () => {
    expect(() => evaluateCondition("amount >", { amount: 1 })).toThrow(ExpressionEvaluationError);
    expect(() => evaluateCondition("1 +* 2", {})).toThrow(ExpressionEvaluationError);
  });

  it("the thrown error names the expression and preserves the interpreter cause", () => {
    try {
      evaluateCondition("amount >", { amount: 1 });
      expect.unreachable("expected ExpressionEvaluationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionEvaluationError);
      const e = err as ExpressionEvaluationError;
      expect(e.expression).toBe("amount >");
      expect(e.message).toContain("amount >");
      expect(e.cause).toBeDefined();
    }
  });

  it("is distinguishable from not-taken: null/false results never throw", () => {
    // The not-taken paths return; only hard interpreter failures throw.
    expect(() => evaluateCondition("false", {})).not.toThrow();
    expect(() => evaluateCondition("missing > 1", {})).not.toThrow();
  });
});
