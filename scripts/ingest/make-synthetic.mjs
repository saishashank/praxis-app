// Deterministic generator for the synthetic fixtures in tests/fixtures/synthetic/ (M2 T5).
// Everything here is invented (SEC-110): fake codes (ZZ*), prices from a formula, placeholder
// text. No vendor data or announcement wording. Same input -> byte-identical output.
// Usage: node scripts/ingest/make-synthetic.mjs [--out <dir>] [--check]
//   --check  compares the files on disk with a fresh generation and exits 1 on any difference.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FETCHED_AT = "2026-01-01T07:30:00.000Z";
const CODES = ["ZZZ", "ZZY"];
const START = Date.UTC(2020, 0, 6); // a Monday
const SESSIONS = 20;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The first `n` weekdays from START. */
export function sessionDates(n = SESSIONS) {
  const out = [];
  for (let ms = START; out.length < n; ms += 86_400_000) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso(ms));
  }
  return out;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

export function goodBars() {
  const bars = [];
  CODES.forEach((code, c) => {
    sessionDates().forEach((date, i) => {
      const base = 10 + 5 * c + i * 0.02;
      const close = r3(base + 0.4 * Math.sin(i / 3));
      const open = r3(base + 0.4 * Math.sin((i - 1) / 3));
      bars.push({
        code,
        date,
        open,
        high: r3(Math.max(open, close) + 0.1),
        low: r3(Math.min(open, close) - 0.1),
        close,
        volume: 1000 + 10 * i + 100 * c,
        adj_close: r3(close * 0.99),
        source: "yahoo",
        published_at: null,
        fetched_at: FETCHED_AT,
      });
    });
  });
  return bars;
}

/** Good bars plus one example of each failure the validator must reject. */
export function badBars() {
  const g = goodBars();
  const b = (i, patch) => ({ ...g[i], ...patch });
  return [
    g[0],
    b(1, { close: -1 }),
    b(2, { open: null }),
    b(3, { high: 0.5 }),
    b(4, { date: "2020-02-30" }),
    b(5, { volume: 1.5 }),
    { ...g[0] }, // duplicate of the first row
    b(6, { code: "zzz" }),
    b(7, { fetched_at: "yesterday" }),
    b(8, { source: "other" }),
    g[9],
  ];
}

function asxItem(i, over = {}) {
  const day = sessionDates()[i % SESSIONS];
  return {
    id: `SYN-${String(i).padStart(4, "0")}`,
    code: i % 2 === 0 ? "ZZZ" : "ZZY",
    time: `${day}T10:${String(10 + i).padStart(2, "0")}:00+11:00`,
    type: "Synthetic Notice",
    price_sensitive: i % 3 === 0,
    title: `Synthetic announcement number ${i}`,
    url: `https://example.test/synthetic/${i}.pdf`,
    ...over,
  };
}

export function asxFixtures() {
  const list = { data: [0, 1, 2, 3, 4].map((i) => asxItem(i)) };
  const mixed = {
    data: [asxItem(0), { id: "SYN-BAD", code: "zz", title: "" }, asxItem(0), asxItem(1)],
  };
  const env = (status, headers, body) => ({ status, headers, body });
  return {
    "asx-list-ok.json": env(
      200,
      { "content-type": "application/json", etag: '"syn-1"' },
      JSON.stringify(list),
    ),
    "asx-list-mixed.json": env(200, { "content-type": "application/json" }, JSON.stringify(mixed)),
    "asx-list-not-json.json": env(200, { "content-type": "application/json" }, "not json {"),
    "asx-304.json": env(304, {}, ""),
    "asx-429.json": env(429, { "retry-after": "120" }, "synthetic rate limit"),
    "asx-403.json": env(403, { "content-type": "text/html" }, "<html>synthetic forbidden</html>"),
    "asx-challenge.json": env(
      200,
      { "content-type": "text/html" },
      "<!doctype html><html><title>Just a moment</title><body>synthetic challenge page</body></html>",
    ),
  };
}

export function allFiles() {
  const files = {
    "bars-good.json": goodBars(),
    "bars-bad.json": badBars(),
    ...asxFixtures(),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, v]) => [name, JSON.stringify(v, null, 2) + "\n"]),
  );
}

function main() {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(
    args.includes("--out")
      ? args[args.indexOf("--out") + 1]
      : path.join(here, "../../tests/fixtures/synthetic"),
  );
  const files = allFiles();
  if (args.includes("--check")) {
    const bad = Object.entries(files).filter(([n, t]) => {
      try {
        return fs.readFileSync(path.join(out, n), "utf8") !== t;
      } catch {
        return true;
      }
    });
    if (bad.length) {
      console.error(`make-synthetic: out of date: ${bad.map(([n]) => n).join(", ")}`);
      process.exit(1);
    }
    console.log("make-synthetic: up to date");
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(out, n), t);
  console.log(`make-synthetic: wrote ${Object.keys(files).length} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
