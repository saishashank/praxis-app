// Writes scripts/ingest/requirements-arm64.txt for the self-hosted praxis-jobs image on linux/arm64
// (infra requirement §15.1, decision INF-D006). It keeps EXACTLY the versions pinned in
// requirements.txt and lists, for each one, the SHA-256 of every file PyPI publishes that pip may
// pick on CPython 3.12 / Linux aarch64: pure wheels, cp312 / abi3 manylinux|musllinux aarch64 wheels,
// and the sdist. Hashes come only from PyPI's JSON API (never typed by hand). A binary package with no
// aarch64 wheel is reported (pip would have to compile its sdist) and the script exits 1.
// Usage: node scripts/ingest/gen-arm64-reqs.mjs [--check]   (--check: fail if the file is stale)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(dir, "requirements.txt");
const OUT = path.join(dir, "requirements-arm64.txt");

/** @param {string} text @returns {{name: string, version: string}[]} */
export function parsePins(text) {
  const pins = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)/.exec(line);
    if (m) pins.push({ name: m[1].toLowerCase(), version: m[2] });
  }
  return pins;
}

/** Wheel tags pip accepts on CPython 3.12, Linux aarch64 (glibc or musl). */
export function fileFits(filename) {
  if (filename.endsWith(".tar.gz") || filename.endsWith(".zip")) return "sdist";
  if (!filename.endsWith(".whl")) return null;
  const parts = filename.slice(0, -4).split("-");
  if (parts.length < 5) return null;
  const [py, abi, plat] = parts.slice(-3);
  const pyOk = py.split(".").some((t) => t === "py3" || t === "cp312" || /^cp3\d$/.test(t));
  const abiOk = abi.split(".").some((t) => t === "none" || t === "cp312" || t === "abi3");
  if (plat === "any") return pyOk && abiOk ? "pure" : null;
  const platOk = plat
    .split(".")
    .some((t) => /^(manylinux\w*|musllinux\w*)_aarch64$/.test(t) || t === "linux_aarch64");
  if (!platOk || !abiOk) return null;
  // cp3x with abi3 is forward compatible; a plain cp3x ABI must be exactly 3.12.
  if (abi.split(".").includes("abi3")) return "binary";
  return py.split(".").includes("cp312") ? "binary" : null;
}

/** @param {{filename: string, digests: {sha256: string}, yanked?: boolean}[]} files */
export function pickFiles(files) {
  const kinds = new Set();
  const hashes = [];
  for (const f of files) {
    if (f.yanked) continue;
    const k = fileFits(f.filename);
    if (!k) continue;
    kinds.add(k);
    hashes.push(f.digests.sha256);
  }
  return { hashes: [...new Set(hashes)].sort(), kinds };
}

/** @param {typeof fetch} fetchImpl */
export async function build(srcText, fetchImpl = fetch) {
  const header = [
    "# Hashed, fully pinned install set for the Yahoo fetcher on linux/arm64 (self-hosted praxis-jobs",
    "# image, infra requirement §15.1). Same versions as requirements.txt; hashes for CPython 3.12 on",
    "# Linux aarch64 taken from PyPI's JSON API by scripts/ingest/gen-arm64-reqs.mjs. Do not edit by",
    "# hand: change requirements.txt, then run the script and review the diff.",
  ];
  const lines = [...header];
  const problems = [];
  for (const { name, version } of parsePins(srcText)) {
    const res = await fetchImpl(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
    );
    if (!res.ok) {
      problems.push(`${name}==${version}: PyPI answered ${res.status}`);
      continue;
    }
    const body = /** @type {{urls: any[]}} */ (await res.json());
    const { hashes, kinds } = pickFiles(body.urls ?? []);
    if (hashes.length === 0) problems.push(`${name}==${version}: no file fits linux/aarch64`);
    else if (!kinds.has("pure") && !kinds.has("binary"))
      problems.push(`${name}==${version}: only an sdist (no aarch64 wheel)`);
    lines.push(`${name}==${version} \\`);
    hashes.forEach((h, i) =>
      lines.push(`    --hash=sha256:${h}${i < hashes.length - 1 ? " \\" : ""}`),
    );
  }
  return { text: lines.join("\n") + "\n", problems };
}

async function main() {
  const check = process.argv.includes("--check");
  const { text, problems } = await build(readFileSync(SRC, "utf8"));
  for (const p of problems) console.error(`gen-arm64-reqs: ${p}`);
  if (problems.length) process.exit(1);
  if (check) {
    let cur = "";
    try {
      cur = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
    } catch {}
    if (cur !== text) {
      console.error(
        "gen-arm64-reqs: requirements-arm64.txt is stale; run node scripts/ingest/gen-arm64-reqs.mjs",
      );
      process.exit(1);
    }
    console.log("gen-arm64-reqs: up to date");
    return;
  }
  writeFileSync(OUT, text);
  console.log(`gen-arm64-reqs: wrote ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`gen-arm64-reqs: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
