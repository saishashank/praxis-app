export function softmax(z: readonly number[]): number[];
export type TrainItem = { label: string; embedding: number[] };
export function trainHead(
  items: TrainItem[],
  opts?: { epochs?: number; lr?: number; l2?: number },
): { labels: string[]; dim: number; weights: number[][]; bias: number[]; accuracy: number };
export function parseEmbeddings(text: string): {
  modelSha: string;
  dim: number;
  items: TrainItem[];
};
export function buildHead(
  embText: string,
  lock: { sha256: string | null; dim: number },
  opts?: { epochs?: number; lr?: number; l2?: number; minItems?: number; date?: string },
): { ok: true; head: Record<string, unknown>; accuracy: number } | { ok: false; reason: string };
export function run(argv: string[], out?: (s: string) => void): number;
export const DEFAULT_OUT: string;
export const LOCK_FILE: string;
