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

declare module "*.css";
