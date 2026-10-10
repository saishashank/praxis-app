// Nightly maintenance caller (PLT-016, PLT-076, SEC-017). Zero dependencies.
// Usage: node scripts/maintenance/run.mjs  (env: APP_BASE_URL, ACTIONS_HMAC_SECRET)
// Sends one signed POST to /api/internal/maintenance with today's Melbourne date. Output is only
// "maintenance: ok|skipped|failed (HTTP n)" plus counts; the URL, the secret and any response
// body other than the four counts are never printed. Exit 1 on anything but HTTP 200.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sign } from "../smoke/sign.mjs";

const TIMEOUT_MS = 60000;
const has = (v) => typeof v === "string" && v.trim() !== "";
const COUNT_KEYS = ["prunedRuns", "prunedLogs", "prunedNonces", "hashedUsers"];

// The local calendar date in Melbourne (YYYY-MM-DD): the concurrency key's date (PLT-076).
export function melbourneDate(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function run(env, fetchImpl, out, nowMs = () => Date.now()) {
  if (!has(env.APP_BASE_URL) || !has(env.ACTIONS_HMAC_SECRET)) {
    out("maintenance: failed (APP_BASE_URL or ACTIONS_HMAC_SECRET not set)");
    return 1;
  }
  const body = JSON.stringify({ purpose: "maintenance", date: melbourneDate(nowMs()) });
  const headers = {
    "Content-Type": "application/json",
    ...sign(
      env.ACTIONS_HMAC_SECRET,
      body,
      Math.floor(nowMs() / 1000),
      randomBytes(16).toString("hex"),
    ),
  };
  let res;
  try {
    res = await fetchImpl(`${env.APP_BASE_URL.replace(/\/+$/, "")}/api/internal/maintenance`, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    out(
      `maintenance: failed (request failed: ${e && typeof e.name === "string" ? e.name : "Error"})`,
    );
    return 1;
  }
  if (res.status !== 200) {
    out(`maintenance: failed (HTTP ${res.status})`);
    return 1;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // fall through: treated as an unexpected response
  }
  if (data && data.skipped === true) {
    out("maintenance: skipped (HTTP 200) already done for today");
    return 0;
  }
  if (!data || data.ok !== true || !COUNT_KEYS.every((k) => Number.isInteger(data[k]))) {
    out("maintenance: failed (HTTP 200, unexpected response)");
    return 1;
  }
  out(`maintenance: ok (HTTP 200) ${COUNT_KEYS.map((k) => `${k}=${data[k]}`).join(" ")}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.env, fetch, (s) => console.log(s)));
}
