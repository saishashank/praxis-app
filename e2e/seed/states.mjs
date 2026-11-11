// Named e2e seed states (TST-135 (a), D-967): idempotent overlays applied AFTER a scenario so every spec starts
// from a recorded state. E2E_STATES=a,b | all (unset = none). Each state is a module under ./states/ that exports
// `apply(client, nowIso)`: plain SQL against the throwaway main database (real migrations already applied),
// synthetic ZZ data only, fixed names, safe to run twice. They are plain .mjs (not .ts) so prepare-db.mjs, a
// Node script, loads them on any Node 22; tests/e2e/states.test.ts loads every state onto a fresh migrated
// database and applies it twice (AT-85 "every seed state loads").
import * as alertsMuted from "./states/alerts-muted.mjs";
import * as blueprintFull from "./states/blueprint-full.mjs";
import * as expertsQueue from "./states/experts-queue.mjs";
import * as marketBuiltOff from "./states/market-built-off.mjs";
import * as picksTwoSections from "./states/picks-two-sections.mjs";
import * as steelmanCards from "./states/steelman-cards.mjs";

/** The six states of TST-135 (a), in the order `all` applies them. */
export const STATES = {
  "picks-two-sections": picksTwoSections,
  "experts-queue": expertsQueue,
  "steelman-cards": steelmanCards,
  "alerts-muted": alertsMuted,
  "market-built-off": marketBuiltOff,
  "blueprint-full": blueprintFull,
};
export const STATE_NAMES = Object.keys(STATES);

/**
 * "a,b" -> ["a", "b"]; "all" -> every state; empty or unset -> []. An unknown name throws, so a typo in the
 * lane step is a red job and never a silently empty database.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseStates(value) {
  const v = (value ?? "").trim();
  if (v === "") return [];
  if (v === "all") return [...STATE_NAMES];
  const names = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
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
 */
export async function applyStates(client, names, nowIso = new Date().toISOString()) {
  for (const n of names) await STATES[n].apply(client, nowIso);
  return names;
}
