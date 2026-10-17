// Node builtins the PDF export tests use (fixture bytes, sample output). They
// merge with src/dev/node-builtins.d.ts; app code never imports these.

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function mkdirSync(path: string, options: { recursive: true }): void;
}
