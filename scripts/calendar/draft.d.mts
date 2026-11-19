export const JOB: string;
export function melbourneYear(now: Date): number;
export function draftYear(
  db: {
    execute: (q: unknown) => Promise<any>;
    batch: (s: unknown[], mode?: string) => Promise<any>;
  },
  p: { market: string; year: number; now: Date },
): Promise<{
  status: "drafted" | "exists" | "no_rules" | "unknown_market" | "bad_year";
  rows: number;
}>;
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  out?: (line: string) => void,
  deps?: { connect?: (env: Record<string, string | undefined>) => Promise<unknown> },
): Promise<number>;
