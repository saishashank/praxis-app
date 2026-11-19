// System Health: which AI jobs run on a live model (M22 L1, LLM-077, D-1446). Owner only, plain words: the job names come
// from ROLE_WORDS (D-1402), never a job code, and no model id, key or URL is named. Read-only, no model call.
//   "AI jobs: all on written rules (none switched on)"
//   "Case writing: rules only, test run not passed yet"
//   "Case writing: live model, 2 models in order"
// The keys live only in the nightly job (D-1412), so this line does not check them; the nightly run reports a missing key.
import type { Client } from "@libsql/client";
import {
  readLiveRoles,
  routesStatus,
  type RouteReason,
  type RoleRoute,
  type RoutesStatus,
} from "@/lib/llm/factory";
import { ROLE_WORDS } from "@/lib/llm/roster";

export type LlmRoutesHealth = {
  /** "attention" when the setting cannot be read or a switched-on job cannot run live; "ok" otherwise. */
  state: "ok" | "attention";
  /** One line per job that is switched on, or one line when none is. */
  lines: readonly string[];
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const WHY: Readonly<Record<RouteReason, string>> = {
  not_listed: "not switched on",
  bakeoff_not_passed: "test run not passed yet",
  model_not_routable: "no model that may be used for it",
  no_key: "no access key set",
  config_unreadable: "the setting could not be read",
};

const word = (role: string): string => cap(ROLE_WORDS[role] ?? "this task");

function lineOf(r: RoleRoute): string {
  if (r.live) {
    const n = r.models.length;
    return `${word(r.role)}: live model, ${n} ${n === 1 ? "model" : "models"} in order`;
  }
  if (r.listedAlone)
    return `${word(r.role)}: rules only, it follows the ${ROLE_WORDS.words} switch alone`;
  return `${word(r.role)}: rules only, ${WHY[r.reason ?? "not_listed"]}`;
}

/** Pure: the lines from a routes status (computed without keys, see the header). */
export function routesHealthOf(status: RoutesStatus): LlmRoutesHealth {
  if (status.liveRoles === null)
    return {
      state: "attention",
      lines: [`AI jobs: ${WHY.config_unreadable}, all on written rules`],
    };
  const listed = new Set(status.liveRoles);
  // a job is shown when its own name is listed, or when the words switch that governs it is
  const shown = status.roles.filter(
    (r) => listed.has(r.role) || (r.gate !== null && listed.has(r.gate)),
  );
  if (shown.length === 0)
    return { state: "ok", lines: ["AI jobs: all on written rules (none switched on)"] };
  const lines = shown.map(lineOf);
  return { state: shown.some((r) => !r.live) ? "attention" : "ok", lines };
}

/** The lines for the stored setting; a failed read says so instead of throwing. */
export async function loadLlmRoutesHealth(
  db: Pick<Client, "execute">,
  seams: {
    index?: Parameters<typeof routesStatus>[0]["index"];
    roster?: Parameters<typeof routesStatus>[0]["roster"];
  } = {},
): Promise<LlmRoutesHealth> {
  const liveRoles = await readLiveRoles(db);
  return routesHealthOf(routesStatus({ liveRoles, ...seams }, { checkKeys: false }));
}
