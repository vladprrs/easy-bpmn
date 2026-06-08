// Minimal ambient declaration for bpmn-moddle (ships no TypeScript types).
// We use only `fromXML`; the parsed tree is a loosely-typed moddle element tree.

declare module "bpmn-moddle" {
  export interface ModdleElement {
    $type: string;
    $parent?: ModdleElement;
    [key: string]: unknown;
  }

  export interface ParseResult {
    rootElement: ModdleElement;
    references: unknown[];
    warnings: unknown[];
    elementsById: Record<string, ModdleElement>;
  }

  export type ModdlePackage = Record<string, unknown>;

  export class BpmnModdle {
    constructor(
      packages?: Record<string, ModdlePackage>,
      options?: Record<string, unknown>,
    );
    fromXML(
      xml: string,
      typeName?: string,
      options?: Record<string, unknown>,
    ): Promise<ParseResult>;
    toXML(
      element: ModdleElement,
      options?: Record<string, unknown>,
    ): Promise<{ xml: string }>;
  }
}
