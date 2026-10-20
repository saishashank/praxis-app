// M7 design section 4.4 (UX-005, NFR-010): JavaScript budgets measured from the `.next` build output.
// Zero dependencies. Run after `npm run build`.
//   shared first-load JS (chunks every route loads)      <= 120 KB gzip
//   Home, Strategies list, News, Reviews route total     <= 150 KB gzip (shared + route chunks)
//   Lightweight Charts only on company and strategy pages (dynamic import: the library chunk is
//   not part of the first load of any other route)
// Source: .next/diagnostics/route-bundle-stats.json (first-load chunk list per route, written by
// `next build`). KB here means 1000 bytes, the stricter reading.
// Usage: node scripts/ci/bundle-budget.mjs [nextDir]   (default .next)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KB = 1000;

export const BUDGETS = {
  sharedKb: 120,
  routes: { "/": 150, "/strategies": 150, "/news": 150, "/reviews": 150 },
  chartRoutes: ["/market/[code]", "/strategies/[execution]"],
  /** A string that only the Lightweight Charts library chunk contains (its root element class). */
  chartSignature: "tv-lightweight-charts",
};

export const gzipSize = (buf) => zlib.gzipSync(buf, { level: 9 }).length;

/** Normalise a chunk path from the stats file (Windows builds use backslashes). */
export const normChunk = (p) => p.replace(/\\/g, "/").replace(/^\.next\//, "");

/**
 * stats: route-bundle-stats.json content. read(chunk) returns the chunk file as a Buffer.
 * Returns { shared, routes, chartChunks, failures }.
 */
export function evaluate(stats, read, budgets = BUDGETS) {
  const sizes = new Map();
  const gz = (c) => {
    if (!sizes.has(c)) sizes.set(c, gzipSize(read(c)));
    return sizes.get(c);
  };
  const routes = stats.map((r) => {
    const chunks = [...new Set(r.firstLoadChunkPaths.map(normChunk))].filter((c) =>
      c.endsWith(".js"),
    );
    return { route: r.route, chunks, bytes: chunks.reduce((a, c) => a + gz(c), 0) };
  });
  const sharedChunks = routes.length
    ? routes[0].chunks.filter((c) => routes.every((r) => r.chunks.includes(c)))
    : [];
  const shared = { chunks: sharedChunks, bytes: sharedChunks.reduce((a, c) => a + gz(c), 0) };

  const chartChunks = [...new Set(routes.flatMap((r) => r.chunks))].filter((c) =>
    read(c).includes(budgets.chartSignature),
  );

  const failures = [];
  if (shared.bytes > budgets.sharedKb * KB) {
    failures.push(
      `shared first-load JS ${(shared.bytes / KB).toFixed(1)} KB gzip exceeds ${budgets.sharedKb} KB`,
    );
  }
  for (const [route, limit] of Object.entries(budgets.routes)) {
    const r = routes.find((x) => x.route === route);
    if (!r) failures.push(`route ${route} is missing from the build output`);
    else if (r.bytes > limit * KB) {
      failures.push(`route ${route} ${(r.bytes / KB).toFixed(1)} KB gzip exceeds ${limit} KB`);
    }
  }
  for (const r of routes) {
    if (budgets.chartRoutes.includes(r.route)) continue;
    const hit = r.chunks.filter((c) => chartChunks.includes(c));
    if (hit.length) {
      failures.push(`route ${r.route} loads Lightweight Charts up front (${hit.join(", ")})`);
    }
  }
  return { shared, routes, chartChunks, failures };
}

export function table(result, budgets = BUDGETS) {
  const rows = [["Item", "Gzip KB", "Budget KB", "Result"]];
  const mark = (bytes, limit) => (bytes > limit * KB ? "OVER" : "ok");
  rows.push([
    "shared first-load",
    (result.shared.bytes / KB).toFixed(1),
    String(budgets.sharedKb),
    mark(result.shared.bytes, budgets.sharedKb),
  ]);
  for (const r of result.routes) {
    const limit = budgets.routes[r.route];
    rows.push([
      `route ${r.route}`,
      (r.bytes / KB).toFixed(1),
      limit ? String(limit) : "-",
      limit ? mark(r.bytes, limit) : "",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ")).join("\n");
}

export function run(nextDir = path.join(ROOT, ".next")) {
  const statsFile = path.join(nextDir, "diagnostics/route-bundle-stats.json");
  if (!fs.existsSync(statsFile)) {
    throw new Error(`${statsFile} not found: run \`npm run build\` first`);
  }
  const stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
  return evaluate(stats, (c) => fs.readFileSync(path.join(nextDir, c)));
}

function main() {
  let result;
  try {
    result = run(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  } catch (e) {
    console.error(`bundle-budget: ${e.message}`);
    process.exit(1);
  }
  console.log(table(result));
  console.log(
    `Lightweight Charts chunk(s): ${result.chartChunks.join(", ") || "none found in any first load"}`,
  );
  if (result.failures.length) {
    for (const f of result.failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("bundle-budget: all budgets met");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
