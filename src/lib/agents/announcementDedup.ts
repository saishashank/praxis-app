// Announcement de-duplication (M14 WP5; DAT-237, D-240). A repost of an announcement must not make
// a second event. Two steps, both on the stored title only (no full text is kept):
//   1. exact: the same code and the same normalised title published on the same day;
//   2. near: an in-house MinHash (128 seeded hash functions over word 3-shingles of the normalised
//      title); the same code, within `windowSessions` sessions and an estimated Jaccard similarity
//      at or above the threshold marks the later item a duplicate of the earlier one.
// Pure and deterministic: the hash seeds are constants, there is no clock and no random source, so
// live and replay agree without storing a flag. The exact content hash that the ingest route
// stores (`announcement.content_hash`) is built from the same `normaliseTitle`.
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";

export const MINHASH_SIZE = 128; // threshold-ok: number of seeded hash functions (D-240)
export const SHINGLE_WORDS = 3; // threshold-ok: words per shingle (D-240)
const SEED = 0x9e3779b9; // threshold-ok: fixed seed constant (golden-ratio fraction)

/** Lower-case, letters and digits only, single spaces: the form both dedup steps compare. */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Murmur3 32-bit finaliser: a bijective integer mixer. */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; // threshold-ok: murmur3 mixing constant
  h = Math.imul(h, 0x85ebca6b); // threshold-ok: murmur3 mixing constant
  h ^= h >>> 13; // threshold-ok: murmur3 mixing constant
  h = Math.imul(h, 0xc2b2ae35); // threshold-ok: murmur3 mixing constant
  h ^= h >>> 16; // threshold-ok: murmur3 mixing constant
  return h >>> 0;
}

/** FNV-1a 32-bit of a string (UTF-16 code units). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5; // threshold-ok: FNV-1a constant
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // threshold-ok: FNV-1a constant
  }
  return h >>> 0;
}

/** Word 3-shingles of a normalised title; a title under three words is one shingle. */
export function shingles(normalised: string): string[] {
  const words = normalised.length === 0 ? [] : normalised.split(" ");
  if (words.length === 0) return [];
  if (words.length <= SHINGLE_WORDS) return [words.join(" ")];
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return [...out];
}

const SEEDS: readonly number[] = Array.from(
  { length: MINHASH_SIZE },
  (_, i) => mix32((SEED + Math.imul(i + 1, 0x7f4a7c15)) >>> 0), // threshold-ok: seed spreading constant
);

/** MinHash signature: per seeded hash function, the smallest hash over the shingles. */
export function minhashSignature(normalised: string): Uint32Array {
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff); // threshold-ok: 32-bit all-ones sentinel
  for (const sh of shingles(normalised)) {
    const base = fnv1a(sh);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const h = mix32((base ^ SEEDS[i]!) >>> 0);
      if (h < sig[i]!) sig[i] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity: the share of equal signature positions. */
export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

export type DedupItem = {
  readonly source: string;
  readonly ann_id: string;
  readonly code: string;
  readonly published_at: string;
  readonly title: string;
  /** Day-0 session of the item (the distance between items is counted in sessions). */
  readonly session: string;
};

export type DedupOptions = {
  readonly calendar: readonly CalendarRow[];
  readonly windowSessions: number;
  readonly threshold: number;
};

export type DedupResult = {
  /** `${source}|${ann_id}` of every duplicate -> the earlier item it repeats. */
  readonly duplicates: ReadonlyMap<string, string>;
};

const keyOf = (a: Pick<DedupItem, "source" | "ann_id">): string => `${a.source}|${a.ann_id}`;

function order(a: DedupItem, b: DedupItem): number {
  if (a.published_at !== b.published_at) return a.published_at < b.published_at ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.ann_id < b.ann_id ? -1 : a.ann_id > b.ann_id ? 1 : 0;
}

type Kept = { item: DedupItem; norm: string; sig: Uint32Array };

/** Sessions from `from` to `to` (0 = the same session; the inputs are session dates, `from` <= `to`). */
function sessionGap(from: string, to: string, calendar: readonly CalendarRow[]): number {
  if (to <= from) return 0;
  return Math.max(0, sessionsBetween(from, to, calendar).length - 1);
}

/**
 * Duplicates among `items`, oldest first. A later item is compared with the earlier KEPT items of
 * the same code only, so a chain of slowly drifting titles does not collapse into one.
 */
export function dedupAnnouncements(items: readonly DedupItem[], opts: DedupOptions): DedupResult {
  const duplicates = new Map<string, string>();
  const keptByCode = new Map<string, Kept[]>();
  for (const item of [...items].sort(order)) {
    const norm = normaliseTitle(item.title);
    const kept = keptByCode.get(item.code) ?? [];
    let dupOf: Kept | undefined;
    for (const k of kept) {
      if (sessionGap(k.item.session, item.session, opts.calendar) > opts.windowSessions) continue;
      if (
        norm.length > 0 &&
        k.norm === norm &&
        k.item.published_at.slice(0, 10) === item.published_at.slice(0, 10) // threshold-ok: length of a YYYY-MM-DD date prefix
      ) {
        dupOf = k; // exact
        break;
      }
    }
    if (dupOf === undefined) {
      const sig = minhashSignature(norm);
      for (const k of kept) {
        if (norm.length === 0) break;
        if (sessionGap(k.item.session, item.session, opts.calendar) > opts.windowSessions) continue;
        if (minhashSimilarity(k.sig, sig) >= opts.threshold) {
          dupOf = k;
          break;
        }
      }
      if (dupOf === undefined) {
        kept.push({ item, norm, sig });
        keptByCode.set(item.code, kept);
        continue;
      }
    }
    duplicates.set(keyOf(item), keyOf(dupOf.item));
  }
  return { duplicates };
}
