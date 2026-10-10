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
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
declare module "*.yml?raw" {
  const text: string;
  export default text;
}
