// The go-live sign-off (M8 T11; docs/M8_design.md decisions 33 and 34; D-125). HIGH RISK: this row
// is what lets the Owner switch production to `full`. Owner only; every checklist item ticked; an
// explicit typed confirmation; audit event FIRST, then ONE row in the append-only `go_live_signoff`
// (via the D-066 controls runner). It never switches the mode itself: after the sign-off the Owner
// sets AU to `full` in the data controls, and the interlock (interlock.ts) then lets it through.
// No secret, name or email is stored: the actor is an auth-DB user id and the note is free text the
// Owner wrote (no more than 500 characters). Allowed while the market is data-only (it must be).
import type { Client } from "@libsql/client";
import {
  commit,
  fail,
  NOOP,
  ownerCheck,
  type ControlBase,
  type ControlResult,
} from "@/lib/data/controls";
import {
  COMMIT_RE,
  GO_LIVE_ITEM_IDS,
  GO_LIVE_MARKET,
  SIGNOFF_CONFIRM_PHRASE,
  SIGNOFF_NOTE_MAX,
} from "./checklist";

export type SignoffRow = {
  id: number;
  market: string;
  signedBy: number;
  signedAt: string;
  releaseCommit: string;
  items: string[];
  note: string;
};

/** The release commit this deployment runs, from the deploy's environment; null when unknown. */
export function deployedCommit(env: Record<string, string | undefined>): string | null {
  for (const raw of [env.APP_COMMIT, env.VERCEL_GIT_COMMIT_SHA]) {
    const v = (raw ?? "").trim().toLowerCase();
    if (COMMIT_RE.test(v)) return v;
  }
  return null;
}

export async function loadSignoffs(db: Pick<Client, "execute">): Promise<SignoffRow[]> {
  const r = await db.execute({
    sql:
      "SELECT id, market, signed_by, signed_at, release_commit, items_json, note " +
      "FROM go_live_signoff WHERE market = ? ORDER BY id DESC LIMIT 20",
    args: [GO_LIVE_MARKET],
  });
  return r.rows.map((x) => ({
    id: Number(x.id),
    market: String(x.market),
    signedBy: Number(x.signed_by),
    signedAt: String(x.signed_at),
    releaseCommit: String(x.release_commit),
    items: JSON.parse(String(x.items_json)) as string[],
    note: String(x.note),
  }));
}

export type SignoffInput = ControlBase & {
  items: unknown;
  confirmation: unknown;
  note?: unknown;
  /** Used only when the deployment does not report its own commit. */
  commit?: unknown;
};

// Control characters other than tab and line breaks are refused in the note.
const BAD_NOTE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/**
 * Error codes: forbidden, invalid, items_missing, confirm_required, commit_unknown, unavailable.
 * Nothing is audited or written for a refusal. A sign-off for a commit that already has one changes
 * nothing.
 */
export async function signOffGoLive(p: SignoffInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (!Array.isArray(p.items) || !p.items.every((x) => typeof x === "string")) {
    return fail("invalid");
  }
  const ticked = new Set(p.items as string[]);
  if (ticked.size !== p.items.length || [...ticked].some((x) => !GO_LIVE_ITEM_IDS.includes(x))) {
    return fail("invalid");
  }
  if (!GO_LIVE_ITEM_IDS.every((id) => ticked.has(id))) return fail("items_missing");
  if (p.confirmation !== SIGNOFF_CONFIRM_PHRASE) return fail("confirm_required");
  const noteRaw = p.note ?? "";
  if (typeof noteRaw !== "string") return fail("invalid");
  const note = noteRaw.trim();
  if (note.length > SIGNOFF_NOTE_MAX || BAD_NOTE_CHARS.test(note)) return fail("invalid");
  const typed = typeof p.commit === "string" ? p.commit.trim().toLowerCase() : "";
  const release = deployedCommit(p.env) ?? (COMMIT_RE.test(typed) ? typed : null);
  if (release === null) return fail("commit_unknown");
  const items = GO_LIVE_ITEM_IDS.filter((id) => ticked.has(id));
  try {
    const dup = await p.mainDb.execute({
      sql: "SELECT 1 FROM go_live_signoff WHERE market = ? AND release_commit = ?",
      args: [GO_LIVE_MARKET, release],
    });
    if (dup.rows.length > 0) return NOOP;
    return await commit(p, now, {
      action: "golive.signoff",
      targetType: "market",
      targetId: GO_LIVE_MARKET,
      detail: { market: GO_LIVE_MARKET, releaseCommit: release, items, noteLength: note.length },
      apply: async (tx, auditRef) => {
        await tx.execute({
          sql:
            "INSERT INTO go_live_signoff (market, signed_by, signed_at, release_commit, " +
            "items_json, note, audit_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [GO_LIVE_MARKET, p.actorId, now, release, JSON.stringify(items), note, auditRef],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}
