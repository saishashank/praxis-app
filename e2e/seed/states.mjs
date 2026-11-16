// Named e2e seed states (TST-135 (a), D-967): idempotent overlays applied AFTER a scenario so every spec starts
// from a recorded state. E2E_STATES=a,b | all (unset = none). Each state is a module under ./states/ that exports
// `apply(client, nowIso)`: plain SQL against the throwaway main database (real migrations already applied),
// synthetic ZZ data only, fixed names, safe to run twice. They are plain .mjs (not .ts) so prepare-db.mjs, a
// Node script, loads them on any Node 22; tests/e2e/states.test.ts loads every state onto a fresh migrated
// database and applies it twice (AT-85 "every seed state loads").
import * as alertsMuted from "./states/alerts-muted.mjs";
import * as blueprintFull from "./states/blueprint-full.mjs";
import * as expertsQueue from "./states/experts-queue.mjs";
import * as labelsQueue from "./states/labels-queue.mjs";
import * as marketBuiltOff from "./states/market-built-off.mjs";
import * as ownerToolsOn from "./states/owner-tools-on.mjs";
import * as picksTwoSections from "./states/picks-two-sections.mjs";
import * as reviewStored from "./states/review-stored.mjs";
import * as steelmanCards from "./states/steelman-cards.mjs";

/** The six states of TST-135 (a) and the three of M21 A1 (D-1236), in the order they are applied. */
export const STATES = {
  "picks-two-sections": picksTwoSections,
  "experts-queue": expertsQueue,
  "steelman-cards": steelmanCards,
  "alerts-muted": alertsMuted,
  "market-built-off": marketBuiltOff,
  "blueprint-full": blueprintFull,
  "owner-tools-on": ownerToolsOn,
  "review-stored": reviewStored,
  "labels-queue": labelsQueue,
};
export const STATE_NAMES = Object.keys(STATES);
/**
 * What `all` means: the states that leave the configuration at its defaults. `owner-tools-on` switches the Owner tools
 * on in the throwaway database (D-1214, D-1243), so it is named explicitly: `E2E_STATES=all,owner-tools-on`.
 */
export const OPT_IN_STATES = ["owner-tools-on"];
export const ALL_STATE_NAMES = STATE_NAMES.filter((n) => !OPT_IN_STATES.includes(n));

/**
 * "a,b" -> ["a", "b"]; "all" -> every state except the opt-in ones (owner-tools-on), "all,owner-tools-on" adds it; empty or unset -> []. An unknown name throws, so a typo in the
 * lane step is a red job and never a silently empty database.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseStates(value) {
  const v = (value ?? "").trim();
  if (v === "") return [];
  const names = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .flatMap((n) => (n === "all" ? ALL_STATE_NAMES : [n]));
  for (const n of names) {
    if (!(n in STATES))
      throw new Error(`unknown e2e state "${n}" (known: ${STATE_NAMES.join(", ")})`);
  }
  return [...new Set(names)];
}

/**
 * Applies the named states in order.
 * @param {import("@libsql/client").Client} client
 * @param {string[]} names
 * @param {string} [nowIso]
 * @param {{ viewerId?: string }} [ctx] the auth-DB id of the seeded viewer (user rows live in the auth DB; pick_alert.user_id is String(app_user.id))
 */
export async function applyStates(client, names, nowIso = new Date().toISOString(), ctx = {}) {
  for (const n of names) await STATES[n].apply(client, nowIso, ctx);
  return names;
}
