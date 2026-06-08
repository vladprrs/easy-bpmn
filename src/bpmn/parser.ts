// Namespace-aware BPMN 2.0 parsing via bpmn-moddle. This layer ONLY parses XML
// into a typed moddle tree (matched by {MODEL-ns}localName, never by prefix) and
// registers the easy-bpmn extension descriptor. It holds no runtime state and no
// profile rules — those live in validator.ts.

import { BpmnModdle, type ModdleElement } from "bpmn-moddle";
import { easyBpmnModdle } from "./moddle-extension";

export interface ParseOk {
  ok: true;
  definitions: ModdleElement;
  warnings: unknown[];
}

export interface ParseFail {
  ok: false;
  error: string;
}

export type ParseOutcome = ParseOk | ParseFail;

/**
 * Parse BPMN XML. Returns `ok: false` only when the document is not well-formed /
 * not parseable BPMN 2.0. Warnings (e.g. foreign-namespace extension content) are
 * surfaced but NEVER turned into a parse failure — BPMN requires tolerating them.
 */
export async function parseBpmnXml(xml: string): Promise<ParseOutcome> {
  const moddle = new BpmnModdle({ "easy-bpmn": easyBpmnModdle });
  try {
    const { rootElement, warnings } = await moddle.fromXML(xml, "bpmn:Definitions");
    if (!rootElement || rootElement.$type !== "bpmn:Definitions") {
      return { ok: false, error: "Root element is not a BPMN <definitions>." };
    }
    return { ok: true, definitions: rootElement, warnings: warnings ?? [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `BPMN XML is not well-formed or parseable: ${message}` };
  }
}

/**
 * Parse → re-serialize → return the round-tripped XML. Used by the canonicity
 * test (SAGA design §3, note R3): an accepted file must re-serialize through a
 * standard moddle without losing standard elements. `bpmn-js` is the operative
 * human round-trip check; this is the automated semantic round-trip.
 */
export async function roundTripBpmnXml(xml: string): Promise<string> {
  const moddle = new BpmnModdle({ "easy-bpmn": easyBpmnModdle });
  const { rootElement } = await moddle.fromXML(xml, "bpmn:Definitions");
  const { xml: out } = await moddle.toXML(rootElement, { format: false });
  return out;
}
