// The single masking module (DAT-124, ROL-107, UX-009; docs/M7_design.md 2.4; D-128; HIGH RISK).
//
// Rule: a user who is not the Owner sees "Stock A", "Stock B", ... instead of stock codes and company
// names, no trade prices, no evidence or source links, and ISO weeks instead of exact trade dates,
// unless the Owner has given that user a live `unmask_grant`. Masking is applied on the server, in the
// loader or page, BEFORE any value reaches a client component, a rendered page or a JSON body. A
// client component can therefore never hold a code it may not show. This module is pure (no React, no
// Next); callers pass the databases and the clock. It is meant for server code only: it must never be
// imported from a "use client" file (the unmasked codes it receives live on the server).
//
// Active set: the letters are assigned over every code that appears in any record returned for the
// Melbourne date, collected FIRST and masked afterwards; alphabetical by code ("Stock A" ... "Stock Z",
// "Stock AA", ...), so a letter is stable for the whole date and is never re-used within it. A new
// date builds a new set, so letters do not carry across dates.
//
// Failure mode: every uncertainty masks. An unknown role, a failed grant lookup, a code that was not
// in the active set and a name that cannot be mapped all produce a masked result.
import type { Client } from "@libsql/client";
import { can, type Role } from "@/lib/auth/permissions";
import { isoWeek } from "./format";

export type MaskUser = { id: number; role: string | null | undefined };
export type MaskContext = { masked: boolean };

/** Shown in place of a code that is not in the active set (it cannot be given a stable letter). */
export const UNKNOWN_STOCK = "Another stock";
export const LINK_HIDDEN = "[link hidden]";
export const PRICE_HIDDEN = "[price hidden]";

// ---- who is masked -----------------------------------------------------------------------------

export type GrantWindow = { expiresAt: string; revokedAt: string | null };

/** A grant is live while it is not revoked and its expiry is in the future (an unparseable expiry is not live). */
export function isGrantLive(g: GrantWindow, now: Date): boolean {
  if (g.revokedAt !== null) return false;
  const t = Date.parse(g.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

/** Owner and users with a live grant are unmasked; everyone else, and anything unknown, is masked. */
export function maskContext(user: MaskUser | null | undefined, hasLiveGrant: boolean): MaskContext {
  if (!user) return { masked: true };
  if (can(user.role as Role | null | undefined, "unmask")) return { masked: false };
  // Only a known non-Owner role can be unmasked by a grant; an unknown role never is.
  if (user.role !== "editor" && user.role !== "viewer") return { masked: true };
  return { masked: !hasLiveGrant };
}

export async function hasLiveUnmaskGrant(
  authDb: Pick<Client, "execute">,
  userId: number,
  now: Date,
): Promise<boolean> {
  const r = await authDb.execute({
    sql: "SELECT expires_at FROM unmask_grant WHERE user_id = ? AND revoked_at IS NULL",
    args: [userId],
  });
  return r.rows.some((x) => isGrantLive({ expiresAt: String(x.expires_at), revokedAt: null }, now));
}

/** The mask context of a signed-in user. Call once per request; a lookup failure masks. */
export async function maskContextFor(
  user: MaskUser | null | undefined,
  authDb: Pick<Client, "execute">,
  now: Date = new Date(),
): Promise<MaskContext> {
  if (!user) return { masked: true };
  if (can(user.role as Role | null | undefined, "unmask")) return { masked: false };
  try {
    return maskContext(user, await hasLiveUnmaskGrant(authDb, user.id, now));
  } catch {
    return { masked: true };
  }
}

// ---- letters -----------------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 27 -> "AB", ... (bijective base 26). */
export function letterOf(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("bad stock index");
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % ALPHABET.length;
    out = ALPHABET[r] + out;
    n = Math.floor((n - 1) / ALPHABET.length);
  }
  return out;
}

export const normCode = (code: string): string => code.trim().toUpperCase();

/** The letters of one Melbourne date's active set. Build it from ALL codes before masking anything. */
export class StockAliases {
  private readonly byCode = new Map<string, string>();

  constructor(codes: Iterable<string | null | undefined>) {
    const set = new Set<string>();
    for (const c of codes) if (typeof c === "string" && c.trim() !== "") set.add(normCode(c));
    [...set]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .forEach((c, i) => this.byCode.set(c, `Stock ${letterOf(i)}`));
  }

  get size(): number {
    return this.byCode.size;
  }
  has(code: string): boolean {
    return this.byCode.has(normCode(code));
  }
  /** "Stock A"; a code outside the set gives UNKNOWN_STOCK, never the code. */
  label(code: string | null | undefined): string {
    if (typeof code !== "string") return UNKNOWN_STOCK;
    return this.byCode.get(normCode(code)) ?? UNKNOWN_STOCK;
  }
  codes(): string[] {
    return [...this.byCode.keys()];
  }
}

// ---- lookups -----------------------------------------------------------------------------------

export type MaskLookup = {
  /** Every instrument code of the market: a free-text token in this set is masked even if it was not in a record. */
  known: ReadonlySet<string>;
  /** Company names by code. */
  names: ReadonlyMap<string, string>;
};

export const EMPTY_LOOKUP: MaskLookup = { known: new Set(), names: new Map() };

export async function loadMaskLookup(
  mainDb: Pick<Client, "execute">,
  market: string,
): Promise<MaskLookup> {
  const r = await mainDb.execute({
    sql: "SELECT code, name FROM instrument WHERE market = ?",
    args: [market],
  });
  const known = new Set<string>();
  const names = new Map<string, string>();
  for (const x of r.rows) {
    const code = normCode(String(x.code));
    known.add(code);
    names.set(code, String(x.name));
  }
  return { known, names };
}

// ---- text --------------------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const PRICE_RE = /(?:A\$|AUD\s?|\$)\s?\d[\d,]*(?:\.\d+)?/g;
const DATE_IN_TEXT_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const TOKEN_RE = /(?<![A-Za-z0-9])[A-Z0-9][A-Z0-9]{1,5}(?![A-Za-z0-9])/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MIN_NAME_LENGTH = 3; // threshold-ok: shorter names would match ordinary words

type NameMatcher = { re: RegExp; codeOf: ReadonlyMap<string, string> };
const MATCHERS = new WeakMap<ReadonlyMap<string, string>, NameMatcher | null>();

/** One case-insensitive matcher over every company name of the lookup, longest name first (cached). */
function nameMatcher(lookup: MaskLookup): NameMatcher | null {
  if (MATCHERS.has(lookup.names)) return MATCHERS.get(lookup.names)!;
  const codeOf = new Map<string, string>();
  for (const [code, name] of lookup.names) {
    const n = name.trim();
    if (n.length >= MIN_NAME_LENGTH && !codeOf.has(n.toLowerCase()))
      codeOf.set(n.toLowerCase(), code);
  }
  let out: NameMatcher | null = null;
  if (codeOf.size > 0) {
    const alt = [...codeOf.keys()]
      .sort((x, y) => y.length - x.length)
      .map(escapeRe)
      .join("|");
    out = { re: new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, "gi"), codeOf };
  }
  MATCHERS.set(lookup.names, out);
  return out;
}

/**
 * Masks free text: company names and codes of the active set become letters, any other known code or
 * company name becomes UNKNOWN_STOCK, links and money amounts are removed and exact dates become ISO weeks. Whole
 * upper-case tokens only, so "BHP" is masked and "Bhpx" is not; over-masking is the safe direction.
 */
export function maskText(
  text: string,
  aliases: StockAliases,
  lookup: MaskLookup = EMPTY_LOOKUP,
): string {
  let out = text.replace(URL_RE, LINK_HIDDEN);
  // Company names first (they contain code-like words): the name of a stock of the active set becomes
  // its letter, the name of any other known company becomes "Another stock".
  const names = nameMatcher(lookup);
  if (names !== null) {
    out = out.replace(names.re, (m) => {
      const code = names.codeOf.get(m.toLowerCase());
      return code !== undefined && aliases.has(code) ? aliases.label(code) : UNKNOWN_STOCK;
    });
  }
  out = out.replace(PRICE_RE, PRICE_HIDDEN);
  out = out.replace(DATE_IN_TEXT_RE, (m) => isoWeek(m) ?? m);
  out = out.replace(TOKEN_RE, (tok) => {
    if (aliases.has(tok)) return aliases.label(tok);
    return lookup.known.has(tok) ? UNKNOWN_STOCK : tok;
  });
  return out;
}

/**
 * Backstop for tests and for pages with free text: the codes (of `codes`) that still appear as whole
 * tokens, or whole names, anywhere in `value` (strings inside nested objects and arrays included).
 * Case-insensitive by default (tests); `caseSensitive` matches the upper-case form only (page backstop,
 * where an ordinary lower-case word must not blank a page because it equals a code).
 */
export function findLeaks(
  value: unknown,
  codes: Iterable<string>,
  names: Iterable<string> = [],
  o: { caseSensitive?: boolean } = {},
): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const want = new Set<string>();
  for (const c of codes) want.add(normCode(c));
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]+(?![A-Za-z0-9])/g)) {
    if (want.has(o.caseSensitive ? m[0] : m[0].toUpperCase())) found.add(m[0]);
  }
  const lower = text.toLowerCase();
  for (const n of names) {
    if (n.trim().length >= MIN_NAME_LENGTH && lower.includes(n.trim().toLowerCase())) found.add(n);
  }
  return [...found];
}

/** A stored UTC instant or calendar date shown at ISO-week precision for a masked user. */
export function weekOnly(d: string | null | undefined): string | null {
  if (typeof d !== "string") return null;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(d);
  return day ? isoWeek(day[1]) : null;
}
