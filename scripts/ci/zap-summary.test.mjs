// M8 T12: the ZAP summary (decisions 7, 37, 38): rule id, name, risk, count only; no URL; high
// findings fail unless excepted; expired or malformed exceptions fail. Synthetic reports only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExceptions } from "./exceptions-core.mjs";
import { main, rulesOf, safeName, summarise } from "./zap-summary.mjs";

const alert = (pluginid, name, riskcode, count, extra = {}) => ({
  pluginid,
  alertRef: `${pluginid}-1`,
  alert: name,
  name,
  riskcode: String(riskcode),
  count: String(count),
  desc: "<p>secret-desc https://leak.example/desc</p>",
  solution: "<p>use https://leak.example/fix</p>",
  instances: [
    {
      uri: "https://staging.example.test/path?token=abc123",
      method: "GET",
      param: "sid",
      evidence: "Set-Cookie: session=abc123",
      attack: "x",
    },
  ],
  ...extra,
});
const report = (...alerts) => ({ site: [{ "@name": "https://staging.example.test", alerts }] });
const TODAY = "2026-10-21";
const NO_EXCEPTIONS = { exceptions: [] };
const ex = (over = {}) => ({
  rule: "40012",
  reason: "Accepted: reflected value is escaped by the framework",
  added: "2026-10-20",
  expires: "2026-11-10",
  ...over,
});

test("the table holds rule id, name, risk and count, and nothing from the instances", () => {
  const r = summarise(
    report(
      alert("10038", "Content Security Policy (CSP) Header Not Set", 2, 3),
      alert("10020", "Anti-clickjacking Header", 1, 1),
    ),
    NO_EXCEPTIONS,
    { today: TODAY, label: "local build" },
  );
  assert.match(
    r.text,
    /\| 10038 \| Content Security Policy \(CSP\) Header Not Set \| Medium \| 3 \| - \|/,
  );
  assert.match(r.text, /### ZAP baseline: local build/);
  assert.doesNotMatch(
    r.text,
    /https?:|staging\.example|abc123|session|secret-desc|leak\.example|sid\b|Set-Cookie/,
  );
  assert.equal(r.fail, false);
  assert.match(r.text, /PASS/);
});

test("a high finding fails; informational, low and medium do not", () => {
  const r = summarise(
    report(alert("40012", "Cross Site Scripting (Reflected)", 3, 2), alert("1", "Info", 0, 1)),
    NO_EXCEPTIONS,
    { today: TODAY },
  );
  assert.equal(r.fail, true);
  assert.equal(r.failing.length, 1);
  assert.match(r.text, /FAIL: 1 high-risk rule without an exception/);
  assert.equal(
    summarise(report(alert("10202", "Absence of Anti-CSRF Tokens", 2, 9)), NO_EXCEPTIONS, {
      today: TODAY,
    }).fail,
    false,
  );
});

test("an unexpired exception accepts the rule and shows its expiry, not its reason", () => {
  const r = summarise(
    report(alert("40012", "XSS", 3, 1)),
    { exceptions: [ex()] },
    { today: TODAY },
  );
  assert.equal(r.fail, false);
  assert.match(r.text, /until 2026-11-10/);
  assert.doesNotMatch(r.text, /escaped by the framework/);
});

test("an expired exception fails the gate even when nothing matches it", () => {
  const r = summarise(
    report(),
    { exceptions: [ex({ added: "2026-09-01", expires: "2026-09-20" })] },
    { today: TODAY },
  );
  assert.equal(r.fail, true);
  assert.match(r.text, /FAIL: exception 1: expired on 2026-09-20/);
});

test("exceptions need a reason and an expiry of at most 30 days", () => {
  const bad = (over) =>
    checkExceptions({ exceptions: [ex(over)] }, { today: TODAY, keyFields: ["rule"] }).problems;
  assert.equal(bad({}).length, 0);
  assert.equal(bad({ reason: "" }).length, 1);
  assert.equal(bad({ reason: "short" }).length, 1);
  assert.equal(bad({ expires: "2026-11-30" }).length, 1); // 41 days
  assert.equal(bad({ expires: "2026-11-19" }).length, 0); // exactly 30 days
  assert.equal(bad({ expires: "2026-11-20" }).length, 1);
  assert.equal(bad({ added: "yesterday" }).length, 1);
  assert.equal(bad({ expires: "2026-02-30" }).length, 1);
  assert.equal(bad({ rule: "" }).length, 1);
  assert.equal(checkExceptions({}, { today: TODAY, keyFields: ["rule"] }).problems.length, 1);
});

test("rules are merged across sites and sorted worst first; names are cleaned", () => {
  const rep = {
    site: [
      {
        alerts: [
          alert("10038", "CSP", 2, 2),
          alert("40012", "XSS | <b>x</b> https://a.example/x", 3, 1),
        ],
      },
      { alerts: [alert("10038", "CSP", 2, 5)] },
    ],
  };
  const rules = rulesOf(rep);
  assert.deepEqual(
    rules.map((r) => [r.rule, r.risk, r.count]),
    [
      ["40012", "High", 1],
      ["10038", "Medium", 7],
    ],
  );
  assert.equal(rules[0].name, "XSS b x /b");
  assert.equal(safeName("a".repeat(200)).length, 80);
  assert.deepEqual(rulesOf({}), []);
  assert.deepEqual(rulesOf({ site: [{ alerts: [{ pluginid: "bad id", riskcode: "3" }] }] }), []);
});

test("an empty report passes with a single 'no findings' row", () => {
  const r = summarise(report(), NO_EXCEPTIONS, { today: TODAY });
  assert.match(r.text, /no findings/);
  assert.equal(r.fail, false);
});

test("the CLI exit codes, summary file and unreadable input", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zap-"));
  try {
    const rep = path.join(dir, "r.json");
    const exc = path.join(dir, "e.json");
    const sum = path.join(dir, "s.md");
    writeFileSync(exc, JSON.stringify(NO_EXCEPTIONS));
    writeFileSync(rep, JSON.stringify(report(alert("40012", "XSS", 3, 1))));
    const lines = [];
    assert.equal(
      main([rep, "--exceptions", exc], { GITHUB_STEP_SUMMARY: sum }, (s) => lines.push(s)),
      1,
    );
    assert.match(readFileSync(sum, "utf8"), /FAIL/);
    writeFileSync(rep, JSON.stringify(report(alert("10020", "Header", 1, 1))));
    assert.equal(
      main([rep, "--exceptions", exc], {}, () => {}),
      0,
    );
    assert.equal(
      main([path.join(dir, "missing.json"), "--exceptions", exc], {}, (s) => lines.push(s)),
      2,
    );
    assert.equal(
      main([], {}, () => {}),
      2,
    );
    assert.equal(
      main([rep, "--bogus"], {}, () => {}),
      2,
    );
    assert.doesNotMatch(lines.join("\n"), /missing\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed exception file is valid today and empty by default", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(readFileSync(path.join(here, "zap-exceptions.json"), "utf8"));
  const r = checkExceptions(file, { today: TODAY, keyFields: ["rule"] });
  assert.deepEqual(r.problems, []);
});
