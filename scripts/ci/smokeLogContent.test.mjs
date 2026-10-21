// SEC-110, AT-05a, BLD-011: the credential smoke test (stage 1 and stage 2) prints check names,
// PASS/FAIL and short fixed details. Run against fakes whose responses and errors are full of URLs,
// tokens, e-mail addresses and row content; neither stdout nor the job summary may contain any.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as stage1 } from "../smoke/stage1.mjs";
import { run as stage2 } from "../smoke/stage2.mjs";
import { SUITES } from "../smoke/suites.mjs";
import { leaks } from "./logContent.mjs";

const HEX = "ab".repeat(32);
const AGE = `age1${"q".repeat(58)}`;
const VALUES = {
  TURSO_MAIN_URL: "libsql://praxis-secret-db-owner.turso.io",
  TURSO_MAIN_TOKEN: "turso-token-VALUE-0123456789abcdef0123456789",
  RESEND_API_KEY: "re_RESENDKEYVALUE0123456789",
  OWNER_EMAIL: "owner.person@example.com",
  OWNER_RECOVERY_EMAIL: "recovery.person@example.invalid",
  ACTIONS_HMAC_SECRET: HEX,
  PII_HASH_KEY: "cd".repeat(32),
  BACKUP_PUBLIC_KEY: AGE,
  DATA_REPO_TOKEN: "ghp_DATAREPOTOKEN0123456789abcdef",
  DATA_REPO: "praxis-owner/praxis-app-data",
  FIXTURES_READ_TOKEN: "github_pat_FIXTURESTOKEN0123456789",
  FIXTURES_REPO: "praxis-owner/praxis-app-fixtures",
  GOOGLE_AI_API_KEY: "AIzaGOOGLEKEYVALUE0123456789",
  GROQ_API_KEY: "gsk_GROQKEYVALUE0123456789",
  OPENROUTER_API_KEY: "sk-or-OPENROUTERKEYVALUE0123456789",
  CLOUDFLARE_API_TOKEN: "CFTOKENVALUE0123456789abcdef0123456789abcd",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  VERCEL_TOKEN: "VERCELTOKENVALUE0123456789abcdef",
  SMOKE_ENV: "staging",
  APP_BASE_URL: "https://praxis-secret-host.vercel.app",
};
const ROW = "ROWCONTENT-CBA-A$98765.43";
const SECRETS = [
  ...Object.entries(VALUES)
    .filter(([k]) => k !== "SMOKE_ENV")
    .map(([, v]) => v),
  "praxis-secret-host",
  "praxis-secret-db-owner",
  ROW,
];
const HOSTILE_BODY = {
  error: `${ROW} ${VALUES.OWNER_EMAIL} ${VALUES.APP_BASE_URL} ${VALUES.TURSO_MAIN_TOKEN}`,
  message: ROW,
  id: ROW,
  success: false,
  results: [{ type: "error", error: { message: `${ROW} ${VALUES.TURSO_MAIN_URL}` } }],
};

const dir = mkdtempSync(join(tmpdir(), "smoke-log-"));
let n = 0;
const summaryPath = () => join(dir, `summary-${n++}.md`);

// A fetch that answers with `status` and a hostile body for every call.
const hostileFetch = (status) => async () => ({ status, json: async () => HOSTILE_BODY });
// A fetch that always throws an error whose message and cause carry URLs, tokens and e-mail.
const throwingFetch = (name) => async () => {
  throw Object.assign(
    new Error(`fetch failed ${VALUES.APP_BASE_URL} Bearer ${VALUES.RESEND_API_KEY} ${ROW}`),
    {
      name,
      cause: VALUES.OWNER_EMAIL,
    },
  );
};

async function stage1Output(suite, fetchImpl, over = {}) {
  const lines = [];
  const file = summaryPath();
  const code = await stage1(
    ["--suite", suite],
    { ...VALUES, GITHUB_STEP_SUMMARY: file, ...over },
    fetchImpl,
    (s) => lines.push(s),
  );
  let summary = "";
  try {
    summary = readFileSync(file, "utf8");
  } catch {
    // no summary written
  }
  return { code, stdout: lines.join("\n"), summary };
}

function assertClean(label, { stdout, summary }) {
  assert.deepEqual(leaks(stdout, SECRETS), [], `${label}: stdout`);
  assert.deepEqual(leaks(summary, SECRETS), [], `${label}: job summary`);
}

test("stage 1: every suite, every provider answer (200, 401, 500, hostile body): no leak", async () => {
  for (const suite of Object.keys(SUITES)) {
    for (const status of [200, 401, 403, 500]) {
      const out = await stage1Output(suite, hostileFetch(status));
      assertClean(`${suite} HTTP ${status}`, out);
      assert.match(out.stdout, /^CHECK +\| RESULT \| DETAIL/);
    }
  }
});

test("stage 1: every suite when the network throws errors carrying URL, token and e-mail", async () => {
  for (const suite of Object.keys(SUITES)) {
    for (const name of ["TypeError", "AbortError", "Error"]) {
      assertClean(`${suite} ${name}`, await stage1Output(suite, throwingFetch(name)));
    }
  }
});

test("stage 1: a Turso answer that echoes row content does not reach the log", async () => {
  const f = async () => ({
    status: 200,
    json: async () => ({
      results: [
        { type: "ok" },
        { type: "ok" },
        { type: "ok", response: { result: { rows: [[{ type: "text", value: ROW }]] } } },
        { type: "ok" },
        { type: "ok" },
      ],
    }),
  });
  const out = await stage1Output("app-staging", f);
  assertClean("turso rows", out);
  assert.match(out.stdout, /Turso DB round-trip +\| FAIL +\| select mismatch/);
});

test("stage 1: missing and malformed configuration print fixed words, not the values", async () => {
  const bad = {
    TURSO_MAIN_URL: `ftp://${VALUES.OWNER_EMAIL}`,
    OWNER_EMAIL: `not an email ${ROW}`,
    ACTIONS_HMAC_SECRET: `zz-${ROW}`,
    PII_HASH_KEY: undefined,
    FIXTURES_REPO: `bad repo ${VALUES.APP_BASE_URL}`,
  };
  const out = await stage1Output("app-staging", hostileFetch(200), bad);
  assert.deepEqual(leaks(out.stdout, [ROW, VALUES.APP_BASE_URL, VALUES.OWNER_EMAIL]), []);
  assert.deepEqual(leaks(out.summary, [ROW, VALUES.APP_BASE_URL, VALUES.OWNER_EMAIL]), []);
});

test("stage 1: an unknown suite name is not echoed into a path or value", async () => {
  const lines = [];
  const code = await stage1(["--suite", ROW], VALUES, hostileFetch(200), (s) => lines.push(s));
  assert.equal(code, 2);
  assert.ok(!lines.join("\n").includes(ROW));
});

async function stage2Output(fetchImpl, over = {}) {
  const lines = [];
  const file = summaryPath();
  const code = await stage2(
    [],
    { ...VALUES, GITHUB_STEP_SUMMARY: file, ...over },
    fetchImpl,
    (s) => lines.push(s),
    () => 1_700_000_000_000,
  );
  let summary = "";
  try {
    summary = readFileSync(file, "utf8");
  } catch {
    // none
  }
  return { code, stdout: lines.join("\n"), summary };
}

test("stage 2: HTTP errors, network errors and unexpected bodies print status or fixed words", async () => {
  for (const f of [
    hostileFetch(401),
    hostileFetch(500),
    hostileFetch(200),
    throwingFetch("TypeError"),
    async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError(`${ROW} ${VALUES.APP_BASE_URL} ${VALUES.OWNER_EMAIL}`);
      },
    }),
  ]) {
    const out = await stage2Output(f);
    assert.notEqual(out.code, 0);
    assertClean("stage 2", out);
  }
});

test("stage 2: a good report prints names and results only; the base URL and secret never appear", async () => {
  const report = {
    env: "staging",
    commit: null,
    // extra fields a route might add are ignored
    extra: { rows: [ROW], email: VALUES.OWNER_EMAIL },
    results: [
      { name: "AUTH_SECRET format", ok: true, detail: "present, 64 hex" },
      { name: "Turso main", ok: false, detail: "HTTP 500" },
      { name: "WORKER_HMAC_SECRET format", ok: false, pending: true, detail: "not set yet" },
    ],
  };
  const f = async (url) => ({
    status: String(url).endsWith("/login") ? 401 : 200,
    json: async () => report,
  });
  const out = await stage2Output(f);
  assert.equal(out.code, 1);
  assertClean("stage 2 report", out);
  assert.match(out.stdout, /Stage 2 staging: 2\/3 passed, 1 pending/);
});

test("stage 2: missing configuration names the variable only", async () => {
  const out = await stage2Output(hostileFetch(200), { APP_BASE_URL: "", ACTIONS_HMAC_SECRET: HEX });
  assert.equal(out.code, 1);
  assertClean("stage 2 config", out);
});
