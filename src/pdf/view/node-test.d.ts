// Binary reads for the PDF view's fixture tests (vitest runs them in Node).
// Merges with src/dev/node-builtins.d.ts; app code never imports node:*.

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
}
