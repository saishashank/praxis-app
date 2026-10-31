// Cross-checks: a reader that silently drops an entry would hide an element from the model
// (AT-58). Each check compares the reader's result with a looser count of the same source.
import fs from "node:fs";
import path from "node:path";
import { readLlm, readSecrets, readSlots } from "./readers.mjs";

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const text = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const count = (s, re) => [...s.matchAll(re)].length;

const SCHED = "worker/src/schedule.ts";
const SECRETS = "src/lib/security/secretStores.ts";
const SCHEMA = "src/lib/sentinel/schema.ts";
const ROSTER = "src/lib/llm/roster.ts";

/** Problems where a reader found fewer entries than a looser count of the same source. */
export function readerProblems(root) {
  const out = [];
  if (exists(root, SCHED)) {
    const found = readSlots(root).slots.length;
    const loose = count(text(root, SCHED), /\bslot\(\{/g);
    if (found !== loose) out.push(`${SCHED}: ${loose} slot({...}) entries but ${found} read`);
  }
  if (exists(root, SECRETS)) {
    const t = text(root, SECRETS);
    const body = t.slice(t.indexOf("export const SECRET_ROWS"));
    const slotRe =
      /env:\s*"(?:production|staging)",\s*store:\s*"?\w+"?,\s*holder:\s*[^\n]+?,\s*names:\s*\[[^\]]*\]/g;
    const loose = count(body, /\benv:\s*"(?:production|staging)",\s*store:/g);
    if (count(body, slotRe) !== loose) {
      out.push(`${SECRETS}: ${loose} store slots but ${count(body, slotRe)} read`);
    }
    const names = [...body.matchAll(/\bnames:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
    );
    const got = new Set(readSecrets(root).map((x) => x.name));
    for (const n of names) if (!got.has(n)) out.push(`${SECRETS}: secret name ${n} was not read`);
    if (exists(root, SCHEMA)) {
      const blk = /export const CREDENTIAL_NAMES = \{([\s\S]*?)\n\} as const/.exec(
        text(root, SCHEMA),
      );
      const keys = blk ? [...blk[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]) : [];
      const tracked = [...body.matchAll(/tracked:\s*true,\s*key:\s*"(\w+)"/g)].map((m) => m[1]);
      for (const k of keys) {
        if (!tracked.includes(k))
          out.push(`CREDENTIAL_NAME_LIST has ${k}, which no secret row tracks`);
      }
      for (const k of tracked) {
        if (!keys.includes(k))
          out.push(`a secret row tracks ${k}, which CREDENTIAL_NAME_LIST lacks`);
      }
    }
  }
  if (exists(root, ROSTER)) {
    const t = text(root, ROSTER);
    const start = t.indexOf("export const ROSTER");
    const end = t.indexOf("\n];", start);
    const loose = count(t.slice(start < 0 ? 0 : start, end < 0 ? undefined : end), /\bprovider:/g);
    const found = readLlm(root).roster.length;
    if (loose !== found) out.push(`${ROSTER}: ${loose} roster entries but ${found} read`);
  }
  return out;
}
