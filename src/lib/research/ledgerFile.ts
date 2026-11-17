// The offline ledger (M23 A2; D-1606, D-1607, D-1609): `docs/research/registry.json`, a committed, append-only list of the
// looks taken on the build machine. The night imports new entries through the registry gate; nothing else ever writes a
// look from outside the app. Pure logic here (no file or database access): the callers pass a reader. The check is also
// run by `scripts/research/registry-check.mjs --check` (npm `test:research-registry`).
import { canonicalJson, sha256Hex, type PreregItem } from "./registry";
import { isVerdict, type Verdict } from "./verdict";

export const LEDGER_PATH = "docs/research/registry.json";

export type LedgerEntry = {
  readonly seq: number;
  readonly item: PreregItem;
  readonly lineage: string;
  readonly market: string;
  /** sha256 of the frozen text (see `frozenTextFor`). */
  readonly sha: string;
  /** The committed frozen file; `path#D-nnn` freezes the one decision line of a document. */
  readonly preregPath: string;
  readonly lookedAt?: string;
  readonly verdict?: Verdict;
  readonly nSetups?: number;
  readonly nBlocks?: number;
  readonly stats?: Readonly<Record<string, number | string | null>>;
  readonly note?: string;
};

export type Ledger = { readonly format: 1; readonly entries: readonly LedgerEntry[] };

const ITEMS = new Set([
  "CXA-003",
  "CXA-004",
  "CXA-008",
  "CXA-009",
  "CXA-011",
  "CXA-014",
  "VAL-118",
  "DAT-248",
  "VAL-121",
  "VAL-111",
  "M15",
]);
const SHA_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}T/;
const DECISION_ANCHOR = /^(.+)#(D-\d+)$/;

/** Parses the ledger text; throws a plain message on a shape error. */
export function parseLedger(text: string): Ledger {
  const v = JSON.parse(text) as unknown;
  if (typeof v !== "object" || v === null) throw new Error("the ledger is not an object");
  const o = v as Record<string, unknown>;
  if (o.format !== 1 || !Array.isArray(o.entries))
    throw new Error("the ledger has no entries list");
  const entries: LedgerEntry[] = [];
  for (const raw of o.entries as unknown[]) {
    if (typeof raw !== "object" || raw === null) throw new Error("an entry is not an object");
    const e = raw as Record<string, unknown>;
    if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq)) throw new Error("bad seq");
    if (typeof e.item !== "string" || !ITEMS.has(e.item))
      throw new Error(`bad item at seq ${e.seq}`);
    for (const k of ["lineage", "market", "sha", "preregPath"] as const) {
      if (typeof e[k] !== "string" || e[k] === "") throw new Error(`bad ${k} at seq ${e.seq}`);
    }
    if (!SHA_RE.test(e.sha as string)) throw new Error(`bad sha at seq ${e.seq}`);
    if (e.verdict !== undefined) {
      if (!isVerdict(e.verdict)) throw new Error(`bad verdict at seq ${e.seq}`);
      if (typeof e.lookedAt !== "string" || !DAY_RE.test(e.lookedAt))
        throw new Error(`bad lookedAt at seq ${e.seq}`);
      for (const k of ["nSetups", "nBlocks"] as const) {
        const n = e[k];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
          throw new Error(`bad ${k} at seq ${e.seq}`);
      }
      if (typeof e.stats !== "object" || e.stats === null || Array.isArray(e.stats))
        throw new Error(`bad stats at seq ${e.seq}`);
    }
    entries.push(e as unknown as LedgerEntry);
  }
  return { format: 1, entries };
}

/** True when the entry carries a recorded look (a verdict), false when it only freezes a plan. */
export const hasLook = (e: LedgerEntry): boolean => e.verdict !== undefined;

/**
 * The text a frozen file stands for: the whole file with line ends as LF, or for `path#D-nnn` the one decision line of that
 * document, wrapped as `{"record": "<line>"}` so it is JSON. Null when the file or the line is missing.
 */
export function frozenTextFor(
  preregPath: string,
  read: (path: string) => string | null,
): string | null {
  const m = DECISION_ANCHOR.exec(preregPath);
  if (m === null) {
    const text = read(preregPath);
    return text === null ? null : text.replace(/\r\n/g, "\n");
  }
  const doc = read(m[1]!);
  if (doc === null) return null;
  const prefix = `- **${m[2]}**`;
  const line = doc
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((l) => l.startsWith(prefix));
  return line === undefined ? null : canonicalJson({ record: line.trimEnd() });
}

/** Problems in a ledger, in plain words; an empty list means it is sound. */
export function checkLedger(
  entries: readonly LedgerEntry[],
  read: (path: string) => string | null,
): string[] {
  const out: string[] = [];
  const looks = new Set<string>();
  entries.forEach((e, i) => {
    if (e.seq !== i + 1)
      out.push(
        `seq ${e.seq} at position ${i + 1}: the numbers must run 1, 2, 3 with no gap or repeat`,
      );
    const key = `${e.lineage}|${e.market}`;
    if (hasLook(e)) {
      if (looks.has(key)) out.push(`seq ${e.seq}: a second look for ${e.lineage} in ${e.market}`);
      looks.add(key);
    }
    const text = frozenTextFor(e.preregPath, read);
    if (text === null) out.push(`seq ${e.seq}: the frozen file ${e.preregPath} cannot be read`);
    else if (sha256Hex(text) !== e.sha)
      out.push(`seq ${e.seq}: the frozen file ${e.preregPath} does not match its recorded hash`);
  });
  return out;
}

/** Append-only: the earlier ledger must be an exact prefix of the later one. */
export function appendOnlyProblems(
  before: readonly LedgerEntry[],
  after: readonly LedgerEntry[],
): string[] {
  const out: string[] = [];
  if (after.length < before.length) out.push("entries were removed");
  before.forEach((e, i) => {
    const b = after[i];
    if (b !== undefined && canonicalJson(b) !== canonicalJson(e))
      out.push(`seq ${e.seq}: an earlier entry was changed`);
  });
  return out;
}
