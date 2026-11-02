import type { Client } from "@libsql/client";
export const FORMAT: string;
export const MIN_SCHEMA: number;
export function canonical(v: unknown): string;
export function insideRepo(dir: string): boolean;
export function validateKbReport(
  text: string,
  market: string,
): { errors: string[]; report: { front: Record<string, any>; body: string } | null };
export function loadArtefact(dir: string): {
  ok: boolean;
  errors: string[];
  data: Record<string, any>;
  decisions?: {
    ev: any;
    decision: import("../../src/lib/cortex/statusRules.mjs").FamilyDecision;
  }[];
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
