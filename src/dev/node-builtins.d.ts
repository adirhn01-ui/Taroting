// Minimal Node builtin typings for dev-only test files (vitest runs them in
// Node). The project tsconfig deliberately pins `types: ["vite/client"]` so
// app code stays browser-only — do NOT add @types/node globally; extend these
// scoped declarations instead if a dev test needs another builtin.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...segments: string[]): string;
}
