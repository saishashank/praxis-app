// M8 T12: the dependency-audit summary (decision 38): production high/critical always fails,
// development high/critical fails unless excepted with a reason and an expiry within 30 days.
// Synthetic `npm audit --json` shapes only; no URL appears in the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExceptions } from "./exceptions-core.mjs";
import { main, summarise, vulnerabilitiesOf } from "./audit-summary.mjs";

const TODAY = "2026-10-21";
const vuln = (name, severity, ghsa, direct = true) => ({
  name,
  severity,
  isDirect: direct,
  via: ghsa
    ? [
        {
          source: 1,
          name,
          title: "bad thing",
          url: `https://github.com/advisories/${ghsa}`,
          severity,
          range: "<9.9.9",
        },
        "other",
      ]
    : ["other"],
  effects: [],
  range: "<9.9.9",
  fixAvailable: true,
});
const rep = (...vs) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(vs.map((v) => [v.name, v])),
});
const GH = "GHSA-abcd-1234-wxyz";
const ex = (over = {}) => ({
  package: "devtool",
  advisory: GH,
  reason: "Dev-only; the vulnerable path is not used in CI",
  added: "2026-10-20",
  expires: "2026-11-15",
  ...over,
});
const none = { exceptions: [] };

test("a production high finding fails and cannot be excepted", () => {
  const prod = rep(vuln("left-pad", "high", GH));
  const all = prod;
  const r = summarise({
    prod,
    all,
    exceptions: { exceptions: [ex({ package: "left-pad" })] },
    today: TODAY,
  });
  assert.equal(r.fail, true);
  assert.match(r.text, /\| production \| left-pad \| high \| GHSA-ABCD-1234-WXYZ \| - \|/);
  assert.match(r.text, /FAIL: 1 high or critical package/);
});

test("a critical development finding fails without an exception and passes with a valid one", () => {
  const all = rep(vuln("devtool", "critical", GH));
  const prod = rep();
  assert.equal(summarise({ prod, all, exceptions: none, today: TODAY }).fail, true);
  const ok = summarise({ prod, all, exceptions: { exceptions: [ex()] }, today: TODAY });
  assert.equal(ok.fail, false);
  assert.match(ok.text, /until 2026-11-15/);
  assert.doesNotMatch(ok.text, /not used in CI/);
});

test("an exception names a package, and its advisory when given", () => {
  const all = rep(vuln("devtool", "high", "GHSA-zzzz-zzzz-zzzz"));
  const r = summarise({ prod: rep(), all, exceptions: { exceptions: [ex()] }, today: TODAY });
  assert.equal(r.fail, true); // the exception is for a different advisory
  const any = summarise({
    prod: rep(),
    all,
    exceptions: { exceptions: [ex({ advisory: undefined })] },
    today: TODAY,
  });
  assert.equal(any.fail, false);
  const badId = summarise({
    prod: rep(),
    all: rep(),
    exceptions: { exceptions: [ex({ advisory: "CVE-1" })] },
    today: TODAY,
  });
  assert.equal(badId.fail, true);
});

test("an expired exception fails; so does one longer than 30 days", () => {
  const all = rep(vuln("devtool", "high", GH));
  assert.equal(
    summarise({
      prod: rep(),
      all,
      exceptions: { exceptions: [ex({ added: "2026-08-01", expires: "2026-08-20" })] },
      today: TODAY,
    }).fail,
    true,
  );
  assert.equal(
    summarise({
      prod: rep(),
      all,
      exceptions: { exceptions: [ex({ expires: "2027-03-01" })] },
      today: TODAY,
    }).fail,
    true,
  );
  assert.equal(
    summarise({ prod: rep(), all, exceptions: { exceptions: [ex({ reason: "" })] }, today: TODAY })
      .fail,
    true,
  );
});

test("moderate and low findings are counted, not failed, and no URL is printed", () => {
  const all = rep(vuln("a", "moderate", GH), vuln("b", "low", null), vuln("c", "high", GH));
  const r = summarise({
    prod: rep(vuln("c", "high", GH)),
    all,
    exceptions: none,
    today: TODAY,
    label: "root",
  });
  assert.match(r.text, /Development tree: 0 critical, 0 high, 1 moderate, 1 low, 0 info\./);
  assert.match(r.text, /### Dependency audit: root/);
  assert.doesNotMatch(r.text, /https?:|github\.com/);
});

test("a clean audit passes", () => {
  const r = summarise({ prod: rep(), all: rep(), exceptions: none, today: TODAY });
  assert.equal(r.fail, false);
  assert.match(r.text, /no high or critical finding/);
});

test("vulnerabilitiesOf ignores odd shapes and bad names", () => {
  assert.deepEqual(vulnerabilitiesOf(null), []);
  assert.deepEqual(
    vulnerabilitiesOf({ vulnerabilities: { "x y": { name: "x y", severity: "high" } } }),
    [],
  );
  assert.equal(
    vulnerabilitiesOf({ vulnerabilities: { "@s/p": { severity: "weird" } } })[0].severity,
    "info",
  );
});

test("the CLI: exit codes and the summary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  try {
    const p = path.join(dir, "p.json");
    const a = path.join(dir, "a.json");
    const e = path.join(dir, "e.json");
    const s = path.join(dir, "s.md");
    writeFileSync(e, JSON.stringify(none));
    writeFileSync(p, JSON.stringify(rep()));
    writeFileSync(a, JSON.stringify(rep(vuln("devtool", "high", GH))));
    assert.equal(
      main(
        ["--label", "worker", "--prod", p, "--all", a, "--exceptions", e],
        { GITHUB_STEP_SUMMARY: s },
        () => {},
      ),
      1,
    );
    assert.match(readFileSync(s, "utf8"), /Dependency audit: worker/);
    writeFileSync(a, JSON.stringify(rep()));
    assert.equal(
      main(["--prod", p, "--all", a, "--exceptions", e], {}, () => {}),
      0,
    );
    assert.equal(
      main(["--prod", p], {}, () => {}),
      2,
    );
    assert.equal(
      main(["--prod", p, "--all", path.join(dir, "none.json"), "--exceptions", e], {}, () => {}),
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed exception file is valid", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(readFileSync(path.join(here, "audit-exceptions.json"), "utf8"));
  assert.deepEqual(checkExceptions(file, { today: TODAY, keyFields: ["package"] }).problems, []);
});
