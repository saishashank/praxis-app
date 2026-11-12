// Form 4 (insider transactions) -> `insider_notice` (M20 US1; DAT-243, AGT-105; D-1184). The ownership XML lists each
// non-derivative transaction with its code (P open-market purchase, S open-market sale, A award, M exercise, F tax
// withholding, G gift, ...), the shares, the price and the acquired/disposed flag. Only the open-market codes P and S
// are a director trade in the AGT-105 sense: a filing's purchases and sales are summed in micro-currency and the
// larger side names the notice (`director_buy` / `director_sell`); a filing with no P or S, or with equal sides, writes
// nothing (counted). The notice is keyed by the accession, `published_at` = the EDGAR acceptance instant (known time),
// `parser_version` = `form4-v1`. The transaction type is the notice kind (the table has no separate column). The
// XML is a small fixed schema; a tag reader is enough (no dependency) and an unreadable number rejects that
// transaction, never the filing.
import { assertMarketEnabled } from "../../../market/guard.mjs";

export const FORM4_PARSER_VERSION = "form4-v1";
const MICRO = 1_000_000n;

/** Decimal text -> micro as bigint, or null (no float). @param {string | null | undefined} t */
export function microOf(t) {
  if (t === null || t === undefined) return null;
  const m = /^\s*(\d+)(?:\.(\d{1,12}))?\s*$/.exec(t);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(m[1]) * MICRO + BigInt(frac);
}

/** The text of the first `<tag>..</tag>` (or `<tag><value>..</value></tag>`) in `xml`, or null. @param {string} xml @param {string} tag */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  const inner = /<value>([\s\S]*?)<\/value>/i.exec(m[1]);
  return (inner ? inner[1] : m[1]).trim();
}

/** @param {string} xml @param {string} tag */
function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map(
    (m) => m[1],
  );
}

/**
 * @param {string} xml the ownership document
 * @returns {{ symbol: string | null, buyMicro: bigint, sellMicro: bigint, buys: number, sells: number, other: number, rejected: number }}
 */
export function parseForm4(xml) {
  const symbol = tagText(xml, "issuerTradingSymbol")?.toUpperCase() ?? null;
  let buyMicro = 0n;
  let sellMicro = 0n;
  let buys = 0;
  let sells = 0;
  let other = 0;
  let rejected = 0;
  for (const t of blocks(xml, "nonDerivativeTransaction")) {
    const code = (tagText(t, "transactionCode") ?? "").toUpperCase();
    if (code !== "P" && code !== "S") {
      other += 1;
      continue;
    }
    const shares = microOf(tagText(t, "transactionShares"));
    const price = microOf(tagText(t, "transactionPricePerShare"));
    if (shares === null || price === null) {
      rejected += 1;
      continue;
    }
    const value = (shares * price) / MICRO;
    if (code === "P") {
      buyMicro += value;
      buys += 1;
    } else {
      sellMicro += value;
      sells += 1;
    }
  }
  return { symbol, buyMicro, sellMicro, buys, sells, other, rejected };
}

/**
 * The notice a parsed filing yields, or null. @param {{ buyMicro: bigint, sellMicro: bigint, rejected?: number }} p
 * @returns {{ kind: "director_buy" | "director_sell", valueMicro: bigint } | null}
 */
export function noticeOfForm4(p) {
  // an unreadable transaction could flip the direction of the sum: no notice rather than a wrong one (D-1184)
  if (p.rejected > 0) return null;
  if (p.buyMicro === p.sellMicro) return null;
  return p.buyMicro > p.sellMicro
    ? { kind: "director_buy", valueMicro: p.buyMicro }
    : { kind: "director_sell", valueMicro: p.sellMicro };
}

/**
 * @param {{ execute: Function }} db @param {string} market
 * @param {{ annId: string, code: string, kind: string, valueMicro: bigint | null, publishedAt: string }} n
 * @returns {Promise<boolean>} whether a row was written
 */
export async function writeInsiderNotice(db, market, n) {
  await assertMarketEnabled(db, market);
  const r = await db.execute({
    // rows-ok: one insert keyed by (market, ann_id), ignored when the notice exists
    sql: `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (market, ann_id) DO NOTHING`,
    args: [market, n.annId, n.code, n.kind, n.valueMicro, n.publishedAt, FORM4_PARSER_VERSION],
  });
  return r.rowsAffected === 1;
}
