// Test-only module shims: the worker tsconfig loads only the Workers types, not @types/node.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...args: unknown[]): Record<string, unknown>[];
      run(...args: unknown[]): { changes: number | bigint };
    };
    close(): void;
  }
}
// M18 B1 (HMAC v2): tests compute the body SHA-256 the signed message carries.
declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
declare module "*.yml?raw" {
  const text: string;
  export default text;
}
