// Replay snapshot core (M4 T4, DAT-140, design 2.8 and 4.7). Pure: no clock, no randomness, no I/O.
// Assembles the dataset a replay reads (raw bars, index bars, trading calendar, effective
// corporate actions with their factors, universe snapshots, announcements) for ONE date range from
// rows the caller loaded (history files + the recent database window), and serialises it to a
// canonical byte stream: tables in a fixed order, rows sorted by their key (code-unit order, never
// locale), fields in a fixed order, numbers by JSON.stringify. Two builds of the same inputs are
// byte-identical, and `sha` (SHA-256 of the uncompressed stream) is the replay's `snapshot_sha`.
// Point-in-time rules are the replay's job (it asks for `asOf`); the snapshot holds everything in
// the range, with corporate actions limited to ex-date <= `to` (DAT-126).
import { gunzipSync } from "node:zlib";
import { gzipDeterministic, isRealDate, sha256Hex, sydneyDate } from "./rules.mjs";

export const SNAPSHOT_FORMAT = 1;

export class SnapshotError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`snapshot: ${reason}`);
    this.name = "SnapshotError";
    this.reason = reason;
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isStr = (v) => typeof v === "string" && v !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isBool01 = (v) => v === 0 || v === 1;
const isNullableStr = (v) => v === null || typeof v === "string";
const isNullableNum = (v) => v === null || isNum(v);

/**
 * Table specs: field order IS the serialisation order; `key` sorts and de-duplicates; `day` gives
 * the Sydney date used for the range filter; `check` validates one field.
 */
export const TABLES = [
  {
    name: "calendar",
    fields: ["d", "kind", "close_time", "confirmed"],
    key: ["d"],
    day: (r) => r.d,
    ok: {
      d: isRealDate,
      kind: (v) => v === "session" || v === "holiday" || v === "early_close",
      close_time: isNullableStr,
      confirmed: isBool01,
    },
  },
  {
    name: "universe",
    fields: ["d", "code", "status", "tier", "mcap_est", "adv", "halted"],
    key: ["d", "code"],
    day: (r) => r.d,
    ok: {
      d: isRealDate,
      code: isStr,
      status: isStr,
      tier: (v) => v === "U1" || v === "U2" || v === "U3",
      mcap_est: isNullableNum,
      adv: isNullableNum,
      halted: isBool01,
    },
  },
  {
    name: "bars",
    fields: ["code", "d", "o", "h", "l", "c", "volume"],
    key: ["code", "d"],
    day: (r) => r.d,
    ok: {
      code: isStr,
      d: isRealDate,
      o: isNum,
      h: isNum,
      l: isNum,
      c: isNum,
      volume: (v) => isInt(v) && v >= 0,
    },
  },
  {
    name: "index_bars",
    fields: ["index_code", "d", "o_micro", "h_micro", "l_micro", "c_micro"],
    key: ["index_code", "d"],
    day: (r) => r.d,
    ok: {
      index_code: isStr,
      d: isRealDate,
      o_micro: isInt,
      h_micro: isInt,
      l_micro: isInt,
      c_micro: isInt,
    },
  },
  {
    name: "corporate_actions",
    fields: ["code", "ex_date", "action_id", "type", "factor"],
    key: ["code", "ex_date", "action_id"],
    // Everything up to the end of the range: a bar before the range still needs a later factor
    // to be adjusted, and the replay filters by its own decision date (DAT-126).
    day: (r) => r.ex_date,
    upTo: true,
    ok: {
      code: isStr,
      ex_date: isRealDate,
      action_id: isInt,
      type: isStr,
      factor: (v) => isNum(v) && v > 0,
    },
  },
  {
    name: "announcements",
    fields: ["code", "ann_id", "published_at", "type", "price_sensitive", "title"],
    key: ["published_at", "code", "ann_id"],
    day: (r) => sydneyDate(Date.parse(r.published_at)),
    ok: {
      code: isStr,
      ann_id: isStr,
      published_at: (v) => isStr(v) && Number.isFinite(Date.parse(v)),
      type: isNullableStr,
      price_sensitive: isBool01,
      title: (v) => typeof v === "string",
    },
  },
];

const keyOf = (spec, r) => spec.key.map((k) => String(r[k])).join("\u0000");

/** Fold the optional `recent` rows over the history rows: the recent (database) row wins. */
function merge(spec, history, recent) {
  const m = new Map();
  for (const r of history ?? []) m.set(keyOf(spec, r), r);
  for (const r of recent ?? []) m.set(keyOf(spec, r), r);
  return [...m.values()];
}

/**
 * @param {{ from: string, to: string,
 *   inputs: Record<string, object[] | undefined> }} o  inputs.<table> = history rows and
 *   inputs.<table>_recent = rows from the recent database window (they win on the same key)
 * @returns {{ sha: string, text: string, bytes: Uint8Array, counts: Record<string, number>,
 *   from: string, to: string }}
 */
export function buildSnapshot(o) {
  if (!isRealDate(o.from) || !isRealDate(o.to) || o.from > o.to) {
    throw new SnapshotError("bad_range");
  }
  const lines = [];
  const counts = {};
  const body = [];
  for (const spec of TABLES) {
    const rows = merge(spec, o.inputs[spec.name], o.inputs[`${spec.name}_recent`]);
    const kept = [];
    for (const r of rows) {
      for (const f of spec.fields) {
        if (!(f in r) || !spec.ok[f](r[f])) throw new SnapshotError(`bad_row:${spec.name}.${f}`);
      }
      const day = spec.day(r);
      if (spec.upTo ? day > o.to : day < o.from || day > o.to) continue;
      kept.push(r);
    }
    kept.sort((a, b) => {
      for (const k of spec.key) {
        const c = cmp(a[k], b[k]);
        if (c !== 0) return c;
      }
      return 0;
    });
    counts[spec.name] = kept.length;
    for (const r of kept) body.push(JSON.stringify([spec.name, spec.fields.map((f) => r[f])]));
  }
  lines.push(JSON.stringify({ format: SNAPSHOT_FORMAT, from: o.from, to: o.to, counts }));
  lines.push(...body);
  const text = `${lines.join("\n")}\n`;
  const bytes = gzipDeterministic(text);
  return {
    sha: sha256Hex(new TextEncoder().encode(text)),
    text,
    bytes,
    counts,
    from: o.from,
    to: o.to,
  };
}

/**
 * Read a snapshot back (rows as objects) and verify its manifest counts. The sha is recomputed
 * from the stream, so a flipped byte is detected by comparing it with the recorded one.
 * @param {Uint8Array} bytes
 */
export function parseSnapshot(bytes) {
  const raw = gunzipSync(bytes);
  const text = raw.toString("utf8");
  const [head, ...rest] = text.split("\n").filter((l) => l !== "");
  const manifest = JSON.parse(head);
  if (manifest.format !== SNAPSHOT_FORMAT) throw new SnapshotError("bad_format");
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = Object.fromEntries(TABLES.map((t) => [t.name, []]));
  for (const line of rest) {
    const [name, values] = JSON.parse(line);
    const spec = TABLES.find((t) => t.name === name);
    if (!spec) throw new SnapshotError("bad_table");
    tables[name].push(Object.fromEntries(spec.fields.map((f, i) => [f, values[i]])));
  }
  for (const t of TABLES) {
    if (tables[t.name].length !== manifest.counts[t.name]) throw new SnapshotError("bad_counts");
  }
  return { manifest, tables, sha: sha256Hex(new Uint8Array(raw)) };
}
