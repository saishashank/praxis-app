// Host guard (M8 T9, NFR-040, decision 31; M18 OPS-107 / D-965).
//   staging   no request may go to ASX or Yahoo (the blocked suffix list).
//   recorded  (PRAXIS_ENV=recorded, the CI "recorded day") EVERY host except loopback is refused.
// `guardFetch` wraps a fetch implementation; `installHostGuard` replaces globalThis.fetch for the life
// of a script; in `recorded` mode `installNetGuard` also refuses a non-loopback TCP connect of any
// library (Socket.connect), so a client that does not use fetch is caught too. Production behaviour is
// unchanged (the guard is a no-op there).
// Evidence for the CI job (D-965): in `recorded` mode a refusal appends the fixed line
// `refused <label>` and an installed guard appends `guard-installed <label>` to the file named by
// $PRAXIS_NET_LOG; the job fails on any refusal or on a process that wrote no marker. A line never
// carries a host, URL or path (SEC-110). The error message is fixed for the same reason.
import { appendFileSync } from "node:fs";

/** Host suffixes that staging must never reach (the host itself and every subdomain). */
export const BLOCKED_HOST_SUFFIXES = Object.freeze([
  "asx.com.au",
  "asxonline.com",
  "yahoo.com",
  "yahoo.net",
  "yahooapis.com",
  "yimg.com",
]);

/** @param {string} host */
export function isBlockedHost(host) {
  const h = String(host).trim().toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Loopback only: localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(host) {
  const h = String(host)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** @param {Record<string, string | undefined>} env */
export const isStaging = (env) => env.PRAXIS_ENV === "staging";
/** @param {Record<string, string | undefined>} env */
export const isRecorded = (env) => env.PRAXIS_ENV === "recorded";

const RECORDED_MESSAGE = "host refused on the recorded day (D-965)";

export class BlockedHostError extends Error {
  /** @param {string} [message] */
  constructor(message = "host blocked on staging (NFR-040)") {
    super(message);
    this.name = "BlockedHostError";
  }
}

const LABEL = /^[\w.-]{1,40}$/;
function logLine(env, kind, label) {
  const file = env.PRAXIS_NET_LOG;
  if (typeof file !== "string" || file === "") return;
  const l = LABEL.test(String(label ?? "")) ? String(label) : "unknown";
  try {
    appendFileSync(file, `${kind} ${l}\n`);
  } catch {
    /* the job's last step fails on a missing marker */
  }
}

/** Counts one refusal in $PRAXIS_NET_LOG (recorded mode). Never writes the target. */
export function recordRefusal(env, label = env.PRAXIS_NET_LABEL) {
  logLine(env, "refused", label);
}

/** Says "this process has its guard installed" in $PRAXIS_NET_LOG. */
export function writeGuardMarker(env, label = env.PRAXIS_NET_LABEL) {
  logLine(env, "guard-installed", label);
}

/** Reads the log: refusal count and the labels that wrote a marker. @param {string} text */
export function parseNetLog(text) {
  let refused = 0;
  const markers = new Set();
  for (const line of String(text).split("\n")) {
    if (line.startsWith("refused ")) refused += 1;
    else if (line.startsWith("guard-installed "))
      markers.add(line.slice("guard-installed ".length));
  }
  return { refused, markers: [...markers].sort() };
}

function hostOf(input) {
  const raw =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(/** @type {{ url?: unknown }} */ (input)?.url ?? "");
  return new URL(raw).hostname;
}

/**
 * Throws BlockedHostError for a blocked (staging) or any non-loopback (recorded) or unparseable target.
 * @param {unknown} input @param {Record<string, string | undefined>} env
 */
export function assertAllowedRequest(input, env) {
  const recorded = isRecorded(env);
  if (!recorded && !isStaging(env)) return;
  let host;
  try {
    host = hostOf(input);
  } catch {
    if (recorded) recordRefusal(env);
    throw new BlockedHostError(recorded ? RECORDED_MESSAGE : undefined);
  }
  if (recorded) {
    if (!isLoopbackHost(host)) {
      recordRefusal(env);
      throw new BlockedHostError(RECORDED_MESSAGE);
    }
    return;
  }
  if (isBlockedHost(host)) throw new BlockedHostError();
}

/** @param {typeof fetch} fetchImpl @param {Record<string, string | undefined>} env */
export function guardFetch(fetchImpl, env) {
  return /** @type {typeof fetch} */ (
    async (input, init) => {
      assertAllowedRequest(input, env);
      return fetchImpl(input, init);
    }
  );
}

/**
 * Replace `target.fetch` with the guarded one; returns an undo function.
 * @param {Record<string, string | undefined>} env
 */
export function installHostGuard(env, target = globalThis) {
  const original = target.fetch;
  if (typeof original === "function") target.fetch = guardFetch(original.bind(target), env);
  return () => {
    target.fetch = original;
  };
}

/** The host a Socket.connect call targets, or null for a unix socket or the default (loopback) target. */
export function connectHost(args) {
  // net.connect() hands Socket.connect one already-normalized array: [options, callback]
  if (Array.isArray(args[0])) return connectHost(args[0]);
  const a = args[0];
  if (a !== null && typeof a === "object") {
    if (typeof a.path === "string" && a.path !== "") return null;
    return typeof a.host === "string" && a.host !== "" ? a.host : null;
  }
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return typeof args[1] === "string" && args[1] !== "" ? args[1] : null;
  }
  return null; // a path
}

/**
 * Recorded mode only: refuse any non-loopback TCP connect made through `net` (fetch, http, https, a
 * database driver). `net` is passed in so a test can use a stand-in. Returns an undo function.
 * @param {Record<string, string | undefined>} env @param {{ Socket: { prototype: any } }} net
 */
export function installNetGuard(env, net) {
  if (!isRecorded(env)) return () => {};
  const proto = net.Socket.prototype;
  const original = proto.connect;
  proto.connect = function guardedConnect(...args) {
    const host = connectHost(args);
    if (host !== null && !isLoopbackHost(host)) {
      recordRefusal(env);
      const err = new BlockedHostError(RECORDED_MESSAGE);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args);
  };
  return () => {
    proto.connect = original;
  };
}
