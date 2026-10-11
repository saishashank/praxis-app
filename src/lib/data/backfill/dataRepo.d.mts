export const MAX_FILE_BYTES: number;
export class HistoryError extends Error {
  step: string;
  status: number | null;
  constructor(step: string, status: number | null);
}
export class HistoryConflict extends Error {
  asset: string;
  constructor(asset: string);
}
export type HistoryStore = {
  put(
    location: { tag: string; asset: string },
    bytes: Uint8Array,
  ): Promise<{ result: "uploaded" | "skipped"; sha256: string }>;
};
export function createHistoryStore(cfg: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): HistoryStore;
