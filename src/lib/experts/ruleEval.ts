// Expressed-cluster evaluator (M22 E4; KB-085, D-1436, D-1437). Pure: no database, no network, no clock.
// Evaluates a schema-v2 entry rule (ruleSchema.ts) over the DEVELOPMENT sessions it is handed and closes each
// entry by the fixed exit menu, giving rows for the screening statistic. The caller (devView.ts) passes only
// development sessions, so a session outside the development split is never asked of the data source.
//
// Semantics (documented in docs/rule_schema.md):
//  - a long entry at the close of a session whose entry rule is true; one open position per code at a time;
//  - `hold`: exit at the close n sessions later; `family`: the named family's own exit conditions, evaluated on the
//    close of each later session (intraday stops are read at the close), forced at `max_sessions`;
//  - a position that cannot close inside the handed sessions is dropped (never carried past the window);
//  - net = exit close / entry close - 1; excess = net - the matched control return (null when none exists);
//  - persist and crossing conditions look back inside the handed sessions only (earlier sessions do not count).
import {
  FAMILY_SPECS,
  type ExpressedRule,
  type ExpressionExit,
  type RuleNodeV2,
} from "@/lib/agents/families/ruleSchema";
import { CONFIG_KEYS } from "@/lib/config/keys";

export type FieldValue = number | boolean | string | null;

/** What an expressed rule reads. Production adapts the snapshot world to this; tests pass a synthetic table. */
export interface RuleDataSource {
  codes(): readonly string[];
  /** The value of a rule field for a code on a session date (null: not available). */
  field(code: string, field: string, d: string): FieldValue;
  /** The code's sector under the market's classification scheme (null: unclassified). */
  sector(code: string): string | null;
  /** The adjusted close of a code on a session date. */
  close(code: string, d: string): number | null;
  /** The matched-control return over the same window (D-595); null when no control exists. */
  control(code: string, entryD: string, exitD: string): number | null;
}

export type ExpressedRow = {
  readonly code: string;
  readonly entryD: string;
  readonly exitD: string;
  /** Entry session index among the handed sessions. */
  readonly session: number;
  readonly net: number;
  readonly excess: number | null;
};

type Cx = {
  /** The value `back` sessions before the evaluated one (0 = that session); null before the data starts. */
  value(field: string, back: number): FieldValue;
  /** The sector median of a numeric field `back` sessions before; null when it cannot be formed. */
  median(field: string, back: number): number | null;
  param(key: string): number | null;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function compare(op: string, a: number | boolean | string, b: number | boolean | string): boolean {
  if (op === "==") return a === b;
  if (!isNum(a) || !isNum(b)) return false;
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return false;
  }
}

type Node = Record<string, unknown>;

function evalNode(node: unknown, cx: Cx, back: number): boolean {
  const n = node as Node;
  if ("rel_sector" in n) {
    const o = n.rel_sector as { field: string; op: string; value: number };
    const v = cx.value(o.field, back);
    const med = cx.median(o.field, back);
    return isNum(v) && med !== null && compare(o.op, v - med, o.value);
  }
  if ("ratio" in n) {
    const o = n.ratio as { num: string; den: string; op: string; value: number };
    const a = cx.value(o.num, back);
    const b = cx.value(o.den, back);
    return isNum(a) && isNum(b) && b !== 0 && compare(o.op, a / b, o.value);
  }
  if ("persist" in n) {
    const o = n.persist as { n: number; m: number; when: unknown };
    let hits = 0;
    for (let k = 0; k < o.m; k++) if (evalNode(o.when, cx, back + k)) hits += 1;
    return hits >= o.n;
  }
  if ("logic" in n) {
    const items = n.items as unknown[];
    return n.logic === "AND"
      ? items.every((x) => evalNode(x, cx, back))
      : items.some((x) => evalNode(x, cx, back));
  }
  if ("count_of" in n) {
    const o = n.count_of as { n: number | { param: string }; items: unknown[] };
    const need = typeof o.n === "number" ? o.n : cx.param(o.n.param);
    if (need === null) return false;
    return o.items.filter((x) => evalNode(x, cx, back)).length >= need;
  }
  // a condition: {field, op, value | param}
  const field = String(n.field);
  const op = String(n.op);
  const want = "param" in n ? cx.param(String(n.param)) : (n.value as number | boolean | string);
  if (want === null || want === undefined) return false;
  const now = cx.value(field, back);
  if (now === null) return false;
  if (op === "crosses_above" || op === "crosses_below") {
    const prev = cx.value(field, back + 1);
    if (!isNum(prev) || !isNum(now) || !isNum(want)) return false;
    return op === "crosses_above" ? prev <= want && now > want : prev >= want && now < want;
  }
  return compare(op, now, want);
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** The numeric default of a Lane-B key (the family exit conditions are evaluated at the registry defaults). */
function paramDefault(key: string): number | null {
  const def = (CONFIG_KEYS as unknown as Record<string, { default?: unknown }>)[key]?.default;
  return isNum(def) ? def : null;
}

/**
 * The rows of one expressed rule over the handed development sessions (ordered, oldest first).
 * Deterministic: codes are visited in sorted order.
 */
export function evaluateExpressed(
  rule: ExpressedRule,
  exit: ExpressionExit,
  sessions: readonly string[],
  source: RuleDataSource,
): ExpressedRow[] {
  const codes = [...source.codes()].sort();
  const bySector = new Map<string, string[]>();
  for (const c of codes) {
    const s = source.sector(c);
    if (s === null) continue;
    bySector.set(s, [...(bySector.get(s) ?? []), c]);
  }
  const medianCache = new Map<string, number | null>();
  const medianOf = (code: string, field: string, idx: number): number | null => {
    const sector = source.sector(code);
    if (sector === null || idx < 0) return null;
    const key = `${sector}\u0000${field}\u0000${idx}`;
    if (medianCache.has(key)) return medianCache.get(key)!;
    const vals: number[] = [];
    for (const peer of bySector.get(sector) ?? []) {
      const v = source.field(peer, field, sessions[idx]!);
      if (isNum(v)) vals.push(v);
    }
    const m = median(vals);
    medianCache.set(key, m);
    return m;
  };
  const familyExits =
    exit.kind === "family"
      ? FAMILY_SPECS[exit.family].actions.filter((a) => a.action === "exit")
      : [];
  const rows: ExpressedRow[] = [];
  const n = sessions.length;

  for (const code of codes) {
    const at = (idx: number): Cx => ({
      value: (field, back) =>
        idx - back < 0 ? null : source.field(code, field, sessions[idx - back]!),
      median: (field, back) => medianOf(code, field, idx - back),
      param: paramDefault,
    });
    let i = 0;
    while (i < n) {
      if (!evalNode(rule.entry as RuleNodeV2, at(i), 0)) {
        i += 1;
        continue;
      }
      const entryClose = source.close(code, sessions[i]!);
      if (entryClose === null || !(entryClose > 0)) {
        i += 1;
        continue;
      }
      let j = -1;
      if (exit.kind === "hold") {
        if (i + exit.sessions < n) j = i + exit.sessions;
      } else {
        let best = entryClose;
        for (let k = i + 1; k < n && k <= i + exit.max_sessions; k++) {
          const c = source.close(code, sessions[k]!);
          if (c === null) continue;
          best = Math.max(best, c);
          const base = at(k);
          const cx: Cx = {
            ...base,
            value: (field, back) => {
              if (back !== 0) return base.value(field, back);
              if (field === "sessions_held") return k - i;
              if (field === "return_since_entry_pct") return (c / entryClose - 1) * 100;
              if (field === "max_gain_since_entry_pct") return (best / entryClose - 1) * 100;
              return base.value(field, 0);
            },
          };
          const shut = familyExits.some((a) => evalNode((a as { when: unknown }).when, cx, 0));
          if (shut || k === i + exit.max_sessions) {
            j = k;
            break;
          }
        }
      }
      if (j < 0) break; // cannot close inside the handed sessions: this and every later entry is dropped
      const exitClose = source.close(code, sessions[j]!);
      if (exitClose !== null) {
        const net = exitClose / entryClose - 1;
        const ctl = source.control(code, sessions[i]!, sessions[j]!);
        rows.push({
          code,
          entryD: sessions[i]!,
          exitD: sessions[j]!,
          session: i,
          net,
          excess: ctl === null ? null : net - ctl,
        });
      }
      i = j + 1;
    }
  }
  return rows.sort(
    (a, b) => a.session - b.session || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}
