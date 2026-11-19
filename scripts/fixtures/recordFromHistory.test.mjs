// M20 IN1 (D-1119, D-927, SEC-110): the offline recorder of another market's window from the history extract.
// A synthetic history folder; nothing is fetched; the history never lands inside the repo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./record-day.mjs";
import { HistoryError, recordFromHistory, sessionsFrom } from "./recordFromHistory.mjs";

const HEAD = "TradDt,Sgmt,FinInstrmTp,TckrSymb,SctySrs,FinInstrmNm,ClsPric";
const bhav = (d, codes) =>
  [
    HEAD,
    ...codes.map((c) => `${d},CM,STK,${c},EQ,"${c} LTD, THE",10.00`),
    `${d},FO,STK,AAA,EQ,x,1`,
  ].join("\n") + "\n";

function history(dates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  for (const d of dates) {
    fs.mkdirSync(path.join(dir, "bhavcopy", d.slice(0, 4)), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bhavcopy", d.slice(0, 4), `${d}.csv`),
      bhav(d, ["AAA", "BBB", "CCC"]),
    );
    fs.mkdirSync(path.join(dir, "bands"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bands", `${d}.csv`),
      "Symbol,Series,Security Name,Band,Remarks\nAAA,EQ,A,5,-\nBBB,EQ,B,No Band,-\nCCC,EQ,C,2,-\n",
    );
  }
  fs.mkdirSync(path.join(dir, "surveillance"), { recursive: true });
  const last = dates.at(-1);
  fs.writeFileSync(
    path.join(dir, "surveillance", `asm_${last}.json`),
    JSON.stringify({
      longterm: { data: [{ symbol: "AAA" }, { symbol: "CCC" }] },
      shortterm: { data: [] },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "surveillance", `gsm_${last}.json`),
    JSON.stringify([{ symbol: "BBB" }, { symbol: "CCC" }]),
  );
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta", "classification.csv"),
    'Company Name,Industry,Symbol,Series,ISIN Code\n"AAA, Ltd.",Metals,AAA,EQ,X\nZZZ Ltd.,Other,ZZZ,EQ,Y\n',
  );
  return dir;
}
const DATES = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"];

test("the window is the last N sessions that have a file, skipping a closed day", () => {
  const dir = history(DATES);
  assert.deepEqual(sessionsFrom(dir, "2026-11-11", 5), DATES.slice(1));
  assert.deepEqual(sessionsFrom(dir, "2026-11-06", 2), ["2026-11-05", "2026-11-06"]);
});

test("records the fixture universe only, per session, and a list under its own date only", () => {
  const dir = history(DATES);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fx-"));
  const r = recordFromHistory({
    market: "IN",
    from: dir,
    out,
    date: "2026-11-11",
    sessions: 5,
    codes: ["AAA", "CCC"],
  });
  assert.equal(r.folders.length, 5);
  const first = path.join(out, "recorded", "in", "2026-11-04");
  const text = fs.readFileSync(path.join(first, "bhavcopy.csv"), "utf8");
  assert.match(text, /AAA/);
  assert.doesNotMatch(text, /BBB/); // not in the fixture universe
  assert.doesNotMatch(text, /,FO,/); // the cash segment only
  assert.match(text, /"AAA LTD, THE"|AAA LTD, THE/); // a quoted comma survives
  assert.deepEqual(fs.readdirSync(first).sort(), [
    "bands.csv",
    "bhavcopy.csv",
    "classification.csv",
  ]);
  const lastDir = path.join(out, "recorded", "in", "2026-11-11");
  assert.deepEqual(fs.readdirSync(lastDir).sort(), [
    "asm.json",
    "bands.csv",
    "bhavcopy.csv",
    "gsm.json",
  ]);
  const gsm = JSON.parse(fs.readFileSync(path.join(lastDir, "gsm.json"), "utf8"));
  assert.deepEqual(
    gsm.map((x) => x.symbol),
    ["CCC"],
  ); // BBB is outside the universe
  assert.match(fs.readFileSync(path.join(first, "classification.csv"), "utf8"), /AAA/);
  assert.doesNotMatch(fs.readFileSync(path.join(first, "classification.csv"), "utf8"), /ZZZ/);
});

test("bad arguments are refused", () => {
  const dir = history(DATES);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fx-"));
  assert.throws(
    () => recordFromHistory({ market: "IN", from: dir, out, date: "11-11-2026", codes: ["AAA"] }),
    HistoryError,
  );
  assert.throws(
    () => recordFromHistory({ market: "IN", from: dir, out, date: "2026-11-11", codes: [] }),
    HistoryError,
  );
  assert.throws(
    () =>
      recordFromHistory({
        market: "IN",
        from: path.join(dir, "nope"),
        out,
        date: "2026-11-11",
        codes: ["AAA"],
      }),
    HistoryError,
  );
  assert.throws(
    () => recordFromHistory({ market: "IN", from: dir, out, date: "2020-01-01", codes: ["AAA"] }),
    HistoryError,
  );
});

test("record-day --market goes offline, and refuses a destination or a source inside the repo", async () => {
  const dir = history(DATES);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fx-"));
  const lines = [];
  const errs = [];
  const sink = {
    out: (s) => lines.push(s),
    err: (s) => errs.push(s),
    fetch: () => assert.fail("no network"),
  };
  const code = await run(
    ["--market", "IN", "--from", dir, "--out", out, "--date", "2026-11-11", "--codes", "AAA,CCC"],
    {},
    sink,
  );
  assert.equal(code, 0);
  assert.match(lines.join(""), /market=IN sessions=5 files=\d+ codes=2/);
  const repo = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
    "..",
    "..",
  );
  const inside = await run(
    [
      "--market",
      "IN",
      "--from",
      dir,
      "--out",
      path.join(repo, "tmp-fixtures"),
      "--date",
      "2026-11-11",
      "--codes",
      "AAA",
    ],
    {},
    sink,
  );
  assert.equal(inside, 2);
  const histInside = await run(
    [
      "--market",
      "IN",
      "--from",
      path.join(repo, "docs"),
      "--out",
      out,
      "--date",
      "2026-11-11",
      "--codes",
      "AAA",
    ],
    {},
    sink,
  );
  assert.equal(histInside, 2);
  assert.ok(errs.length >= 2);
});
