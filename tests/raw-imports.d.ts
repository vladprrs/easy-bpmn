// Vite `?raw` import of an on-disk BPMN sample (examples/*.bpmn). The
// vitest-pool-workers pipeline runs Vite transforms in Node BEFORE injecting
// modules into workerd, so the file content arrives as a plain string — no
// filesystem access is needed inside the Workers runtime.
//
// Lives in its own AMBIENT declaration file (no imports/exports): inside a
// module file (like env.d.ts) a `declare module` with a wildcard pattern is
// treated as an augmentation and never registers the ambient module.
declare module "*.bpmn?raw" {
  const xml: string;
  export default xml;
}
