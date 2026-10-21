// SEC-110, AT-05a: the nightly maintenance caller prints counts and fixed words only. Run against
// fakes whose responses and errors are full of URLs, tokens, e-mail addresses and row content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./run.mjs";
import { leaks } from "../ci/logContent.mjs";

const HOST = "https://praxis-secret-host.vercel.app";
const HMAC = "9f".repeat(32);
const EMAIL = "owner.person@example.com";
const ROW = "ROWCONTENT-BHP-A$12345.67";
const SECRETS = [HOST, "praxis-secret-host", HMAC, EMAIL, ROW];
const NOW = () => Date.parse("2026-10-10T20:30:00Z");
const env = { APP_BASE_URL: HOST, ACTIONS_HMAC_SECRET: HMAC };
const COUNTS = { prunedRuns: 1, prunedLogs: 2, prunedNonces: 3, hashedUsers: 4 };

async function exec(fetchImpl, e = env) {
  const lines = [];
  const code = await run(e, fetchImpl, (s) => lines.push(s), NOW);
  return { code, text: lines.join("\n") };
}
const respond = (status, body) => async () => ({ status, json: async () => body });

const HOSTILE = {
  ...COUNTS,
  ok: true,
  skipped: false,
  message: `${ROW} sent to ${EMAIL} via ${HOST}/api`,
  rows: [{ user: EMAIL, token: HMAC }],
  detail: `Bearer ${HMAC}`,
};

test("success: counts only, however much extra data the response carries", async () => {
  const { code, text } = await exec(respond(200, HOSTILE));
  assert.equal(code, 0);
  assert.match(
    text,
    /^maintenance: ok \(HTTP 200\) prunedRuns=1 prunedLogs=2 prunedNonces=3 hashedUsers=4$/,
  );
  assert.deepEqual(leaks(text, SECRETS), []);
});

test("skipped: a fixed sentence, whatever the body says", async () => {
  const { code, text } = await exec(
    respond(200, { skipped: true, message: `${ROW} ${EMAIL} ${HOST}` }),
  );
  assert.equal(code, 0);
  assert.equal(text, "maintenance: skipped (HTTP 200) already done for today");
  assert.deepEqual(leaks(text, SECRETS), []);
});

test("HTTP errors print the status code, never the body", async () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    const { code, text } = await exec(
      respond(status, { error: `${ROW} ${HOST} ${EMAIL} ${HMAC}` }),
    );
    assert.equal(code, 1);
    assert.equal(text, `maintenance: failed (HTTP ${status})`);
    assert.deepEqual(leaks(text, SECRETS), []);
  }
});

test("unexpected 200 bodies print a fixed sentence", async () => {
  for (const body of [
    null,
    { ok: true, prunedRuns: `${ROW}`, prunedLogs: 0, prunedNonces: 0, hashedUsers: 0 },
    { ok: false, error: `${EMAIL} ${HOST}` },
  ]) {
    const { code, text } = await exec(respond(200, body));
    assert.equal(code, 1);
    assert.equal(text, "maintenance: failed (HTTP 200, unexpected response)");
    assert.deepEqual(leaks(text, SECRETS), []);
  }
});

test("a body that cannot be parsed prints a fixed sentence, not the parse error", async () => {
  const f = async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError(`Unexpected token in ${HOST}: ${ROW} ${EMAIL}`);
    },
  });
  const { code, text } = await exec(f);
  assert.equal(code, 1);
  assert.deepEqual(leaks(text, SECRETS), []);
});

test("network failures print the error name only, even when the message holds the URL and token", async () => {
  for (const make of [
    () =>
      Object.assign(new TypeError(`fetch failed ${HOST} Bearer ${HMAC} ${EMAIL}`), { cause: ROW }),
    () => Object.assign(new Error(`connect ECONNREFUSED ${HOST} ${ROW}`), { name: "AbortError" }),
    () => `plain string ${HOST} ${HMAC}`,
    () => null,
  ]) {
    const { code, text } = await exec(async () => {
      throw make();
    });
    assert.equal(code, 1);
    assert.match(text, /^maintenance: failed \(request failed: [A-Za-z]+\)$/);
    assert.deepEqual(leaks(text, SECRETS), []);
  }
});

test("missing configuration names the variable, never a value", async () => {
  for (const e of [
    { APP_BASE_URL: "", ACTIONS_HMAC_SECRET: HMAC },
    { APP_BASE_URL: HOST, ACTIONS_HMAC_SECRET: undefined },
  ]) {
    const { code, text } = await exec(respond(200, COUNTS), e);
    assert.equal(code, 1);
    assert.deepEqual(leaks(text, SECRETS), []);
  }
});

test("the log scanner itself catches each kind of leak (so the checks above mean something)", () => {
  assert.deepEqual(leaks("see https://x.test/a"), ["url"]);
  assert.ok(leaks("host foo.vercel.app").includes("hostname"));
  assert.ok(leaks("mail a.b@c.invalid").includes("email"));
  assert.ok(leaks(`key ${"a1".repeat(20)}`).includes("token-like string"));
  assert.deepEqual(leaks("row ROWCONTENT-1", ["ROWCONTENT-1"]), ["seeded value #1"]);
  assert.deepEqual(leaks("maintenance: ok (HTTP 200) prunedRuns=1"), []);
});
