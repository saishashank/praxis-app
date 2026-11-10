// INFRA T1 (INFRA §6): the step of the `owner` job in watchdog.yml / ingest-batch1.yml (scheduled
// runs only; it runs on the approved commit and holds the only database secrets). These GitHub `schedule:` backstops belong to the cloud runtime, so they stand by when
// `worker_state.clock_owner` in the main DB names another runtime. Missing database config, any
// error, an absent key or any other value means "cloud": the run goes ahead as it does today.
// Writes `owner=<runtime>` and, ONLY on standby, `run=false` to GITHUB_OUTPUT (`production` skips only when the
// `owner` job's output is exactly 'false'; an empty value, a skipped or a failed job all mean run).
// Mirrors worker/src/owner.ts and src/lib/runtime/owner.ts. No secret, URL or upstream text is logged.
//   env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, GITHUB_OUTPUT (optional)
//   node scripts/time/ownerGate.mjs
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLOCK_OWNER_KEY = "clock_owner";
/** The runtime these workflows belong to. */
export const THIS_RUNTIME = "cloud";
const URL_RE = /^(?:libsql|https):\/\/([^/\s]+)\/?$/;
const TIMEOUT_MS = 10_000;

/** The owner from a stored `value_json`; anything but the JSON string "selfhost" is "cloud". */
export function ownerFrom(valueJson) {
  if (typeof valueJson !== "string") return "cloud";
  try {
    return JSON.parse(valueJson) === "selfhost" ? "selfhost" : "cloud";
  } catch {
    return "cloud";
  }
}

/**
 * Reads the owner (one request) and decides. Never throws.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [f]
 * @returns {Promise<{ run: boolean, owner: "cloud" | "selfhost" }>}
 */
export async function ownerGate(env, f = fetch) {
  let owner = "cloud";
  try {
    const m = URL_RE.exec((env.TURSO_MAIN_URL ?? "").trim());
    const token = (env.TURSO_MAIN_TOKEN ?? "").trim();
    if (m && token !== "") {
      const res = await f(`https://${m[1]}/v2/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              type: "execute",
              stmt: {
                sql: "SELECT value_json FROM worker_state WHERE key = ?",
                args: [{ type: "text", value: CLOCK_OWNER_KEY }],
              },
            },
            { type: "close" },
          ],
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200) {
        const json = await res.json();
        const cell = json?.results?.[0]?.response?.result?.rows?.[0]?.[0];
        owner = ownerFrom(cell?.type === "text" ? cell.value : undefined);
      }
    }
  } catch {
    owner = "cloud";
  }
  return { run: owner === THIS_RUNTIME, owner };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const g = await ownerGate(process.env);
  console.log(
    g.run
      ? `owner-gate: run (owner=${g.owner})`
      : `owner-gate: standby (owner=${g.owner}, runtime=${THIS_RUNTIME})`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `owner=${g.owner}\n${g.run ? "" : "run=false\n"}`);
  }
}
