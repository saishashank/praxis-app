type Db = { execute: (...a: never[]) => unknown };
export function ppmOf(p: unknown): number | null;
export function parsePolymarket(payload: unknown): number | null;
export function parseKalshi(payload: unknown): number | null;
export function sourceEnabled(db: Db, registerId: string): Promise<boolean>;
export type PredictionEvent = { registerId: string; eventKey: string; url: string };
export function fetchPredictionMarkets(
  db: Db,
  deps: {
    fetch: (url: string, init?: unknown) => Promise<{ ok: boolean; text: () => Promise<string> }>;
    now: () => Date;
    d: string;
    events: PredictionEvent[];
  },
): Promise<{ status: "not_enabled" | "done"; stored: number; skipped: number }>;
