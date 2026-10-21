// Third-party notices for Settings > About (UXN-019). Reads package-lock.json (production packages
// only) and writes src/generated/notices.json: name, version, licence and whether the licence is on
// the allow-list {MIT, ISC, BSD-2/3-Clause, Apache-2.0, MPL-2.0, OFL-1.1}; plus the bundled fonts
// and the chart library attribution. Run by `npm run build` (prebuild); `--check` exits 1 when the
// committed file is out of date. Zero dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src", "generated", "notices.json");
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "MPL-2.0",
  "OFL-1.1",
]);

// "A OR B": allowed when any alternative is; "A AND B": allowed when all are.
export function licenceAllowed(expr) {
  if (!expr) return false;
  return expr
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/)
    .some((alt) => alt.split(/\s+AND\s+/).every((l) => ALLOWED.has(l.trim())));
}

export function buildNotices(lock) {
  const byKey = new Map();
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || v.dev) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    byKey.set(`${name}@${v.version}`, {
      name,
      version: v.version,
      license: v.license ?? "UNKNOWN",
      allowed: licenceAllowed(v.license),
    });
  }
  const packages = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const fonts = [
    { name: "Inter", license: "OFL-1.1", note: "Self-hosted at build time by next/font." },
    { name: "JetBrains Mono", license: "OFL-1.1", note: "Self-hosted at build time by next/font." },
  ];
  const attributions = [
    {
      name: "TradingView Lightweight Charts",
      text: "Charts are powered by TradingView Lightweight Charts (Apache-2.0).",
      href: "https://www.tradingview.com/",
    },
  ];
  return { packages, fonts, attributions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const text = JSON.stringify(buildNotices(lock), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (cur !== text) {
      console.error("src/generated/notices.json is out of date: run node scripts/gen-notices.mjs");
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
  }
}
