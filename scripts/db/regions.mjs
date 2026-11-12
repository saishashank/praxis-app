// Generated regions inside a hand-written migration (M20 A2, D-1122). A migration such as 0036 is mostly written
// by hand; the parts that are a projection of something else (the guard triggers of its new tables, the seed delta
// of the profile fields) sit between two marker lines and are rewritten by the generator that owns them:
//   -- BEGIN GENERATED <name> (<generator>)
//   ...
//   -- END GENERATED <name>
// `--check` of each generator compares the region to its own output; nothing outside a region is touched.
import { readFileSync, writeFileSync } from "node:fs";

const begin = (name) => new RegExp(`^-- BEGIN GENERATED ${name}\\b.*$`, "m");
const endLine = (name) => `-- END GENERATED ${name}`;

/** The text between the markers of `name` (without the marker lines), or null when the region is absent. */
export function regionOf(text, name) {
  const b = begin(name).exec(text);
  if (!b) return null;
  const from = b.index + b[0].length + 1;
  const to = text.indexOf(endLine(name), from);
  if (to < 0) throw new Error(`region ${name}: no END marker`);
  return text.slice(from, to);
}

/** `text` with the body of region `name` replaced by `body` (a string ending in a newline). */
export function spliceRegion(text, name, body) {
  const b = begin(name).exec(text);
  if (!b) throw new Error(`region ${name}: no BEGIN marker`);
  const from = b.index + b[0].length + 1;
  const to = text.indexOf(endLine(name), from);
  if (to < 0) throw new Error(`region ${name}: no END marker`);
  return text.slice(0, from) + body + text.slice(to);
}

/** Rewrite (or, with check, compare) one region of a file. Returns true when the file is current. */
export function applyRegion(path, name, body, check) {
  const text = readFileSync(path, "utf8");
  const next = spliceRegion(text, name, body);
  if (check) return next === text;
  if (next !== text) writeFileSync(path, next);
  return true;
}
