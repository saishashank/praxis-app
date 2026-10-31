// Evidence pack (M11-lite WP3; AGT-131, LLM-065; D-486). The core is pure and deterministic: the same
// inputs give the same ids, order and hash. Point-in-time: any item stamped after the decision cut-off
// is left out. Headline text is the only untrusted text and goes to the router as `untrusted`.
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { canonicalJson, sha256Hex } from "@/lib/llm/providers";
import type { Subject } from "./subjects";
import type { Exec } from "./store";

export const PACK_KINDS = [
  "card",
  "rule",
  "regime",
  "event",
  "insider",
  "factor",
  "scenario",
  "liquidity",
  "cost",
  "flag",
  "pick_level",
  "headline",
] as const;
export type PackKind = (typeof PACK_KINDS)[number];
export type PackItem = { id: string; kind: PackKind; text: string; at?: string };
export type RawItem = { kind: PackKind; text: string; at?: string };
export type EvidencePack = { packId: string; items: PackItem[]; cutoffAt: string };
export type PackInput = { cutoffAt: string; maxItems: number; items: readonly RawItem[] };

const MAX_TEXT = 300; // threshold-ok: guard on one item's length
const ABS_MAX_ITEMS = 40; // threshold-ok: evidence_pack_max_items upper bound (E01..E40)
const SPACE_RE = new RegExp("\\s+", "g");

const clean = (s: string) => s.replace(SPACE_RE, " ").trim().slice(0, MAX_TEXT);
const rank = (k: PackKind) => PACK_KINDS.indexOf(k);
const ms = (iso: string) => Date.parse(iso);

export function evidenceId(n: number): string {
  return `E${String(n).padStart(2, "0")}`;
}

export function buildPack(input: PackInput): EvidencePack {
  const cut = ms(input.cutoffAt);
  const seen = new Set<string>();
  const kept: RawItem[] = [];
  for (const it of input.items) {
    const text = clean(it.text);
    if (text === "") continue;
    if (it.at !== undefined && !(ms(it.at) <= cut)) continue; // after the cut-off, or unparseable
    const key = `${it.kind}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ kind: it.kind, text, ...(it.at !== undefined ? { at: it.at } : {}) });
  }
  // Fixed kind order; within a kind the input order, except headlines newest first (D-486).
  const order = new Map(kept.map((k, i) => [k, i]));
  kept.sort((a, b) => {
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind);
    if (a.kind === "headline") {
      const d = ms(b.at ?? "") - ms(a.at ?? "");
      if (d !== 0 && !Number.isNaN(d)) return d;
      return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
    }
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
  const max = Math.max(0, Math.min(Math.trunc(input.maxItems), ABS_MAX_ITEMS));
  const items: PackItem[] = kept.slice(0, max).map((k, i) => ({ id: evidenceId(i + 1), ...k }));
  return { packId: sha256Hex(canonicalJson(items)), items, cutoffAt: input.cutoffAt };
}

/** The untrusted part of a pack (headline text), as "<id>: <text>" lines for the router `untrusted`. */
export function untrustedLines(pack: EvidencePack): string[] {
  return pack.items.filter((i) => i.kind === "headline").map((i) => `${i.id}: ${i.text}`);
}

/** The trusted facts for the router: every non-headline item. */
export function trustedFacts(pack: EvidencePack): { id: string; kind: string; text: string }[] {
  return pack.items
    .filter((i) => i.kind !== "headline")
    .map((i) => ({ id: i.id, kind: i.kind, text: i.text }));
}

const asRec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asRec) : []);
const s = (v: unknown): string => (v === null || v === undefined ? "unknown" : String(v));

/** Raw items of a stored decision card (no LLM; only what the nightly batch stored). */
export function cardItems(card: Record<string, unknown>): RawItem[] {
  const out: RawItem[] = [];
  const ev = asRec(card.evidence);
  out.push({
    kind: "card",
    text: `Family ${s(card.family)} rule ${s(card.rule_version)}: ${s(card.thesis)}`,
  });
  for (const r of asArr(card.rules_fired))
    out.push({
      kind: "rule",
      text: `Rule ${s(r.rule)} value ${s(r.value)} threshold ${s(r.threshold)} ${r.pass === true ? "passed" : "failed"}`,
    });
  out.push({ kind: "regime", text: `Market regime ${s(card.regime)}` });
  for (const e of asArr(ev.events))
    out.push({
      kind: "event",
      text: `Event ${s(e.category)} polarity ${s(e.polarity)} on ${s(e.day0)}`,
    });
  const ins = ev.insider_flow;
  out.push({
    kind: "insider",
    text:
      ins === "unknown" || ins === undefined
        ? "Insider flow unknown"
        : `Insider flow score ${s(asRec(ins).score_q)}`,
  });
  const sc = asRec(card.scenario);
  out.push({
    kind: "scenario",
    text:
      sc.insufficient_history === true
        ? "Scenario history insufficient"
        : `Similar past trades n ${s(sc.n)} p10 ${s(sc.p10_ppm)} p50 ${s(sc.p50_ppm)} p90 ${s(sc.p90_ppm)} ppm`,
  });
  const sz = asRec(card.sizing);
  const why =
    Array.isArray(sz.reasons) && sz.reasons.length > 0 ? ` reasons ${sz.reasons.join(" ")}` : "";
  out.push({
    kind: "liquidity",
    text: `Sizing ${sz.accepted === true ? "accepted" : "not accepted"}${sz.half_size === true ? " at half size" : ""}${why}`,
  });
  const cost = asRec(card.cost);
  out.push({
    kind: "cost",
    text:
      cost.available === true
        ? `Break-even ${s(cost.break_even_ppm)} ppm`
        : `Cost unavailable ${s(cost.reason)}`,
  });
  const flags = [...asList(ev.data_quality_flags), ...asList(ev.other_flags)];
  for (const f of flags) out.push({ kind: "flag", text: `Flag ${s(f)}` });
  return out;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Reads the stored inputs of a subject and returns raw pack items (headlines up to the cut-off only). */
export async function loadPackInput(
  db: Exec,
  subject: Subject,
  market: string,
  d: string,
  params: { maxItems: number; decisionCutoff: string },
): Promise<PackInput> {
  const cutoffAt = decisionCutoffUtc(d, params.decisionCutoff);
  const items: RawItem[] = [];
  if (subject.cardId !== null) {
    const r = await db.execute({
      sql: "SELECT card_json FROM decision_card WHERE id = ?",
      args: [subject.cardId],
    });
    if (r.rows[0]) items.push(...cardItems(asRec(JSON.parse(String(r.rows[0].card_json)))));
  }
  if (subject.kind === "pick" && subject.pickKey) {
    const r = await db.execute({
      sql: "SELECT label, reference_micro, buy_max_micro, stop_micro, aim_micro, valid_until_d, n_similar FROM pick WHERE market = ? AND d = ? AND profile = ? AND rank = ?",
      args: [market, d, subject.pickKey.profile, subject.pickKey.rank],
    });
    const p = r.rows[0];
    if (p)
      items.push({
        kind: "pick_level",
        text: `Pick ${s(p.label)} reference ${s(p.reference_micro)} buy-max ${s(p.buy_max_micro)} stop ${s(p.stop_micro)} aim ${s(p.aim_micro)} micro, valid until ${s(p.valid_until_d)}, n similar ${s(p.n_similar)}`,
      });
  }
  const h = await db.execute({
    sql: "SELECT title, published_at FROM announcement WHERE market = ? AND code = ? AND published_at <= ? ORDER BY published_at DESC, ann_id LIMIT ?",
    args: [market, subject.code, cutoffAt, params.maxItems],
  });
  for (const row of h.rows)
    items.push({ kind: "headline", text: s(row.title), at: s(row.published_at) });
  return { cutoffAt, maxItems: params.maxItems, items };
}
