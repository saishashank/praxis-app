export const SOURCE: "in_nse_asm_gsm";
export type Listed = { code: string; stage: number | null };
export function parseAsm(json: unknown): Listed[];
export function parseGsm(json: unknown): Listed[];
export function surveillanceRows(
  lists: { asm: Listed[]; gsm: Listed[] },
  o: { market: string; d: string },
): (string | number | null)[][];
