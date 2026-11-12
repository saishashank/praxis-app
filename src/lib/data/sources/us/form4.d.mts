export const FORM4_PARSER_VERSION: string;
export function microOf(t: string | null | undefined): bigint | null;
export function parseForm4(xml: string): {
  symbol: string | null;
  buyMicro: bigint;
  sellMicro: bigint;
  buys: number;
  sells: number;
  other: number;
  rejected: number;
};
export function noticeOfForm4(p: {
  buyMicro: bigint;
  sellMicro: bigint;
}): { kind: "director_buy" | "director_sell"; valueMicro: bigint } | null;
export function writeInsiderNotice(
  db: { execute: (...a: never[]) => unknown },
  market: string,
  n: { annId: string; code: string; kind: string; valueMicro: bigint | null; publishedAt: string },
): Promise<boolean>;
