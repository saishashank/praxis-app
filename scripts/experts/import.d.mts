import type { Client } from "@libsql/client";
export const FORMAT: string;
export const MIN_SCHEMA: number;
export function canonical(v: unknown): string;
export function itemId(url: string, contentHash?: string | null): string;
export function insideRepo(dir: string): boolean;
export function loadSeed(dir: string): { ok: boolean; errors: string[]; data: Record<string, any> };
export function plan(data: Record<string, any>): {
  market: string;
  stmts: { tag: string; sql: string; args: unknown[] }[];
};
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: {
    openDb?: (
      url: string,
      token: string | undefined,
    ) => Pick<Client, "execute" | "batch" | "close">;
    out?: (s: string) => void;
    allowInsideRepo?: boolean;
  },
): Promise<number>;
