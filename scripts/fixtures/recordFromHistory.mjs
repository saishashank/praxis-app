// Record a window of sessions of ANOTHER market from the build machine's history extract into the private fixtures
// checkout (M20 IN1; D-1119, D-1092): `record-day.mjs --market IN --from <history/in> --out <fixtures> --date <last>`.
// OFFLINE: it only reads files already pulled by the extract (tools/m20 in the data repo) and writes
//   <out>/recorded/in/<session>/{bhavcopy.csv,bands.csv[,asm.json,gsm.json][,classification.csv]}
// for the fixture universe only (the codes named by --codes), the last N consecutive sessions ending at --date
// (default 5, the AT-M4 window). A list file that exists for one date only (the ASM and GSM snapshots) is written under
// that session's folder alone: an earlier session has no list because none was published to us, and the folder says
// so by having no file (never a copy of a later list, which would read the future). The index and the India VIX are
// not pulled (D-1132), so no index file is written. No network, no secret; the history never enters `praxis-app`
// (SEC-110: `--out` inside this repo is refused by the caller's own check, `isInsideRepo`).
import fs from "node:fs";
import path from "node:path";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9&-]{1,20}$/;

export class HistoryError extends Error {}

/** One CSV line to fields, quote-aware (a quoted field may hold commas). */
function splitCsv(line) {
  const out = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        f += ch;
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(f);
      f = "";
    } else f += ch;
  }
  out.push(f);
  return out;
}

/** CSV lines keeping the header and the rows whose column `col` is in `codes`. */
function filterCsv(text, col, codes, extra = () => true) {
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  const head = splitCsv(lines[0]).map((h) => h.trim());
  const ix = head.indexOf(col);
  if (ix < 0) throw new HistoryError(`column ${col} not found`);
  const keep = [lines[0]];
  for (const l of lines.slice(1)) {
    const c = splitCsv(l);
    if (codes.has(c[ix].trim()) && extra(c, head)) keep.push(l);
  }
  return keep.join("\n") + "\n";
}

/** The sessions (dates with a bhavcopy file) up to and including `date`, newest last. */
export function sessionsFrom(historyDir, date, n) {
  const year = date.slice(0, 4);
  const found = [];
  for (const y of [String(Number(year) - 1), year]) {
    const dir = path.join(historyDir, "bhavcopy", y);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.csv$/.exec(f);
      if (m && m[1] <= date) found.push(m[1]);
    }
  }
  found.sort();
  return found.slice(-n);
}

/**
 * @param {{ market: string, from: string, out: string, date: string, sessions?: number, codes: string[] }} a
 * @returns {{ folders: string[], files: number, codes: number }}
 */
export function recordFromHistory(a) {
  if (!DATE_RE.test(a.date)) throw new HistoryError("--date must be YYYY-MM-DD");
  if (a.codes.length === 0 || !a.codes.every((c) => CODE_RE.test(c)))
    throw new HistoryError("--codes must name the fixture universe");
  if (!fs.existsSync(a.from)) throw new HistoryError("--from does not exist");
  const codes = new Set(a.codes);
  const sessions = sessionsFrom(a.from, a.date, a.sessions ?? 5);
  if (sessions.length === 0) throw new HistoryError("no sessions in the extract up to --date");
  const folders = [];
  let files = 0;
  for (const [i, d] of sessions.entries()) {
    const folder = path.join(a.out, "recorded", a.market.toLowerCase(), d);
    fs.mkdirSync(folder, { recursive: true });
    folders.push(folder);
    const put = (name, text) => {
      fs.writeFileSync(path.join(folder, name), text);
      files += 1;
    };
    const bhav = fs.readFileSync(path.join(a.from, "bhavcopy", d.slice(0, 4), `${d}.csv`), "utf8");
    put(
      "bhavcopy.csv",
      filterCsv(bhav, "TckrSymb", codes, (c, h) => c[h.indexOf("Sgmt")] === "CM"),
    );
    const bands = path.join(a.from, "bands", `${d}.csv`);
    if (fs.existsSync(bands))
      put("bands.csv", filterCsv(fs.readFileSync(bands, "utf8"), "Symbol", codes));
    const asm = path.join(a.from, "surveillance", `asm_${d}.json`);
    if (fs.existsSync(asm)) {
      const j = JSON.parse(fs.readFileSync(asm, "utf8"));
      for (const k of ["longterm", "shortterm"])
        if (j[k]?.data) j[k].data = j[k].data.filter((r) => codes.has(r.symbol));
      put("asm.json", JSON.stringify(j));
    }
    const gsm = path.join(a.from, "surveillance", `gsm_${d}.json`);
    if (fs.existsSync(gsm)) {
      const j = JSON.parse(fs.readFileSync(gsm, "utf8"));
      put("gsm.json", JSON.stringify(Array.isArray(j) ? j.filter((r) => codes.has(r.symbol)) : []));
    }
    if (i === 0) {
      const cls = path.join(a.from, "meta", "classification.csv");
      if (fs.existsSync(cls))
        put("classification.csv", filterCsv(fs.readFileSync(cls, "utf8"), "Symbol", codes));
    }
  }
  return { folders, files, codes: codes.size };
}
