// PLT-076, PLT-016, SEC-017: caller side of the nightly maintenance route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { melbourneDate, run } from "./run.mjs";

const SECRET = "a".repeat(64);
const URL_SECRET = "https://praxis-secret-host.vercel.app";
const NOW_MS = Date.parse("2026-10-10T20:30:00Z"); // 07:30 on 11 Oct in Melbourne (AEDT)
const env = (over = {}) => ({ APP_BASE_URL: URL_SECRET, ACTIONS_HMAC_SECRET: SECRET, ...over });
const OK = {
  ok: true,
  skipped: false,
  date: "2026-10-11",
  prunedRuns: 1,
  prunedLogs: 2,
  prunedNonces: 3,
  hashedUsers: 4,
};
const fakeFetch = (status = 200, body = OK) => {
  const f = async (url, init) => {
    f.calls.push({ url, init });
    return { status, json: async () => body };
  };
  f.calls = [];
  return f;
};
const exec = async (e, f) => {
  const lines = [];
  const code = await run(
    e,
    f,
    (s) => lines.push(s),
    () => NOW_MS,
  );
  return { code, text: lines.join("\n") };
};

test("melbourneDate: uses the Melbourne calendar day, across DST", () => {
  assert.equal(melbourneDate(Date.parse("2026-10-10T20:30:00Z")), "2026-10-11");
  assert.equal(melbourneDate(Date.parse("2026-10-10T12:00:00Z")), "2026-10-10");
  assert.equal(melbourneDate(Date.parse("2026-07-01T14:30:00Z")), "2026-07-02"); // AEST, +10
  assert.equal(melbourneDate(Date.parse("2026-07-01T13:30:00Z")), "2026-07-01");
});

test("sends a signed POST with the purpose and Melbourne date", async () => {
  const f = fakeFetch();
  const { code } = await exec(env(), f);
  assert.equal(code, 0);
  const { url, init } = f.calls[0];
  assert.equal(url, `${URL_SECRET}/api/internal/maintenance`);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { purpose: "maintenance", date: "2026-10-11" });
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, "error");
  const h = init.headers;
  assert.equal(h["X-Praxis-Timestamp"], String(Math.floor(NOW_MS / 1000)));
  assert.match(h["X-Praxis-Nonce"], /^[0-9a-f]{32}$/);
  const mac = createHmac("sha256", SECRET)
    .update(`${h["X-Praxis-Timestamp"]}.${h["X-Praxis-Nonce"]}.${init.body}`)
    .digest("hex");
  assert.equal(h["X-Praxis-Signature"], mac);
});

test("each run uses a fresh nonce", async () => {
  const a = fakeFetch();
  const b = fakeFetch();
  await exec(env(), a);
  await exec(env(), b);
  assert.notEqual(
    a.calls[0].init.headers["X-Praxis-Nonce"],
    b.calls[0].init.headers["X-Praxis-Nonce"],
  );
});

test("ok prints status and the four counts", async () => {
  const { code, text } = await exec(env(), fakeFetch());
  assert.equal(code, 0);
  assert.equal(
    text,
    "maintenance: ok (HTTP 200) prunedRuns=1 prunedLogs=2 prunedNonces=3 hashedUsers=4",
  );
});

test("skipped exits 0", async () => {
  const { code, text } = await exec(env(), fakeFetch(200, { skipped: true }));
  assert.equal(code, 0);
  assert.match(text, /^maintenance: skipped \(HTTP 200\)/);
});

test("non-200 exits 1 and prints only the status", async () => {
  for (const status of [400, 401, 500, 503]) {
    const { code, text } = await exec(env(), fakeFetch(status, { error: "failed" }));
    assert.equal(code, 1);
    assert.equal(text, `maintenance: failed (HTTP ${status})`);
  }
});

test("unexpected 200 bodies exit 1", async () => {
  for (const body of [
    null,
    {},
    { ok: true },
    { ok: true, prunedRuns: "x", prunedLogs: 0, prunedNonces: 0, hashedUsers: 0 },
  ]) {
    assert.equal((await exec(env(), fakeFetch(200, body))).code, 1);
  }
  const f = async () => ({
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  assert.equal((await exec(env(), f)).code, 1);
});

test("missing configuration exits 1 without a request", async () => {
  const f = fakeFetch();
  assert.equal((await exec(env({ APP_BASE_URL: "" }), f)).code, 1);
  assert.equal((await exec(env({ ACTIONS_HMAC_SECRET: undefined }), f)).code, 1);
  assert.equal(f.calls.length, 0);
});

test("network failure prints the error name only", async () => {
  const f = async () => {
    throw Object.assign(new Error(`boom ${URL_SECRET}`), { name: "TimeoutError" });
  };
  const { code, text } = await exec(env(), f);
  assert.equal(code, 1);
  assert.equal(text, "maintenance: failed (request failed: TimeoutError)");
  const g = async () => {
    throw "x";
  };
  assert.match((await exec(env(), g)).text, /request failed: Error/);
});

test("output never contains the secret or the URL", async () => {
  const bodies = [
    fakeFetch(),
    fakeFetch(500),
    fakeFetch(200, { skipped: true }),
    fakeFetch(200, { ok: true, note: URL_SECRET }),
  ];
  for (const f of bodies) {
    const { text } = await exec(env(), f);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes("praxis-secret-host"));
  }
});
