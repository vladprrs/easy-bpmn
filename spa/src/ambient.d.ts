/// <reference types="vite/client" />

// bpmn-js deep entry points ship no bundled types — declare the surface we use.
declare module "bpmn-js/lib/NavigatedViewer" {
  const NavigatedViewer: any;
  export default NavigatedViewer;
}

declare module "bpmn-auto-layout" {
  /** Synthesize bpmndi (ELK→DI) for a DI-less BPMN document; returns laid-out XML. */
  export function layoutProcess(xml: string): Promise<string>;
}

// Deep bpmn-js / diagram-js entry points used by the custom glass renderer.
declare module "diagram-js/lib/draw/BaseRenderer" {
  export default class BaseRenderer {
    constructor(eventBus: any, renderPriority?: number);
    canRender(element: any): boolean;
    drawShape(parent: SVGElement, element: any, attrs?: any): SVGElement;
    drawConnection(parent: SVGElement, connection: any, attrs?: any): SVGElement;
    getShapePath(shape: any): string;
    getConnectionPath(connection: any): string;
  }
}
declare module "bpmn-js/lib/util/ModelUtil" {
  export function is(element: any, type: string): boolean;
  export function isAny(element: any, types: string[]): boolean;
  export function getBusinessObject(element: any): any;
  export function getDi(element: any): any;
}
declare module "tiny-svg" {
  export function create(name: string, attrs?: any): SVGElement;
  export function attr(el: any, attrs: Record<string, any>): any;
  export function append(parent: any, child: any): any;
  export function appendTo(child: any, parent: any): any;
  export function remove(el: any): any;
  export function clear(el: any): any;
  export function innerSVG(el: any, svg: string): any;
  export function classes(el: any): { add(c: string): any; remove(c: string): any; has(c: string): boolean; toggle(c: string, add?: boolean): any };
  export function select(el: any, selector: string): any;
  export function selectAll(el: any, selector: string): any;
}

declare module "*.css";
