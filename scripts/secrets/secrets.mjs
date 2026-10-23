#!/usr/bin/env node
// The Owner's secrets tool (D-176): one command sets a value in every store that holds it (GitHub
// environments, Vercel projects, Cloudflare Workers), so a change never needs four dashboards.
// It runs on the Owner's machine under the Owner's own gh / vercel / wrangler logins. Values are
// typed at a hidden prompt (or piped on stdin, one line per value), or made here for the random
// 64-hex rows; they are passed to each store on stdin only and never printed, logged or saved.
//
//   npm run secrets -- doctor                 who is signed in where
//   npm run secrets -- login                  sign in to Cloudflare and Vercel (browser)
//   npm run secrets -- list [--check]         every value and its places; --check reads the stores
//   npm run secrets -- set <what...>          set a value everywhere it is held
//       <what>    a row id (b, c2, d ...), a preset (worker) or a stored name (RESEND_API_KEY)
//       --env     production (default), staging or all
//       --only    github,vercel,worker (limit the stores)
//       --paste   type a value for a row the tool would otherwise generate
//       --dry-run show the plan, write nothing
//       --yes     do not ask before writing
//       --redeploy start the deploy workflow afterwards (Vercel reads values at deploy time)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CHECKS, CONFIG_ROWS, STORE_ALIASES, describeWrite, planUpdate } from "./plan.mjs";
import {
  ROOT,
  doctorSteps,
  listStep,
  loadTargets,
  loginSteps,
  parseNames,
  redact,
  run as runStep,
  writeSteps,
} from "./stores.mjs";

/** The secret rows (a copy of src/lib/security/secretStores.ts kept equal by its test) + config. */
export function loadRows() {
  const rows = JSON.parse(readFileSync(path.join(ROOT, "scripts/secrets/rows.json"), "utf8"));
  return [...rows, ...CONFIG_ROWS];
}

const ENVS = ["production", "staging", "all"];

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string", default: "production" },
      only: { type: "string" },
      paste: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      redeploy: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (!ENVS.includes(values.env)) throw new Error(`--env must be one of ${ENVS.join(", ")}`);
  let stores;
  if (values.only) {
    stores = values.only.split(",").map((s) => {
      const kind = STORE_ALIASES[s.trim()];
      if (!kind) throw new Error(`--only takes ${Object.keys(STORE_ALIASES).join(", ")}`);
      return kind;
    });
  }
  const [command = "help", ...words] = positionals;
  return { command: values.help ? "help" : command, words, ...values, stores };
}

/** Ask a question; with `hidden`, the typed characters are not echoed. */
export function makePrompter(input = process.stdin, output = process.stdout) {
  if (!input.isTTY) {
    // Piped input: one value per line, in plan order (read on the first question only).
    let lines = null;
    const ask = async () => {
      lines ??= readFileSync(0, "utf8").split(/\r?\n/);
      return (lines.shift() ?? "").trim();
    };
    return { ask, close: () => {} };
  }
  return {
    ask: (question, { hidden = false } = {}) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input, output, terminal: true });
        if (hidden) {
          rl._writeToOutput = (s) => {
            if (s.startsWith(question)) output.write(question);
            else if (/\r|\n/.test(s)) output.write("\n");
          };
        }
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }),
    close: () => {},
  };
}

function printPlan(out, plan) {
  for (const g of plan.groups) {
    const how = g.source === "generate" ? "made here (64 random hex)" : `you type it (${g.check})`;
    out(`\n${g.logical} [${g.env}] — ${g.title}`);
    out(`  value: ${how}${g.source === "paste" ? `; from: ${g.issuer}` : ""}`);
    for (const w of g.writes) out(`  -> ${describeWrite(w)}`);
  }
  for (const s of plan.skipped) out(`\nnot set by the tool (${s.rowId}): ${s.reason}`);
}

async function obtainValue(g, prompter, out) {
  if (g.source === "generate") return randomBytes(32).toString("hex");
  for (let tries = 0; tries < 3; tries++) {
    const v = await prompter.ask(`Value for ${g.logical} [${g.env}]: `, { hidden: true });
    if (CHECKS[g.check](v)) return v;
    out(`  that does not look like a ${g.check} value; try again (nothing was written)`);
  }
  throw new Error(`no valid value for ${g.logical}; nothing written for it`);
}

async function cmdSet(opts, io) {
  const { out, run, targets, prompter } = io;
  if (opts.words.length === 0) throw new Error("set needs what to set, e.g. set b, set worker");
  const plan = planUpdate(io.rows, opts.words, {
    env: opts.env,
    stores: opts.stores,
    paste: opts.paste,
  });
  if (plan.groups.length === 0) {
    printPlan(out, plan);
    throw new Error("nothing to write for that selection");
  }
  out("The plan (names and places only):");
  printPlan(out, plan);
  if (opts["dry-run"]) return 0;
  if (!opts.yes) {
    const answer = await prompter.ask("\nWrite these now? (yes/no): ");
    if (answer.toLowerCase() !== "yes") {
      out("Stopped; nothing written.");
      return 1;
    }
  }
  const values = [];
  let failed = 0;
  for (const g of plan.groups) {
    const value = await obtainValue(g, prompter, out);
    values.push(value);
    out(`\n${g.logical} [${g.env}]`);
    for (const w of g.writes) {
      let ok = true;
      let detail = "";
      for (const step of writeSteps(w, targets)) {
        const r = await run(step, { input: step.stdin ? value : undefined });
        if (r.code !== 0 && !step.mayFail) {
          ok = false;
          detail = redact(
            `${r.stderr || r.stdout}`.trim().split(/\r?\n/).slice(-2).join(" "),
            values,
          );
          break;
        }
      }
      if (!ok) failed++;
      out(`  ${ok ? "ok    " : "FAILED"} ${describeWrite(w)}${detail ? ` — ${detail}` : ""}`);
    }
    if (g.expiryKey)
      out(`  note: record the new expiry date for ${g.expiryKey} on the Ops checklist`);
  }
  const touchesVercel = plan.groups.some((g) => g.writes.some((w) => w.store === "vercel-env"));
  if (touchesVercel) {
    const envs = [...new Set(plan.groups.map((g) => g.env))];
    if (opts.redeploy) {
      for (const env of envs) {
        const d = targets.deploy[env];
        const r = await run({
          cmd: "gh",
          args: ["workflow", "run", d.workflow, "--ref", d.ref, "--repo", targets.repo],
        });
        out(
          r.code === 0
            ? `\nStarted ${d.workflow} on ${d.ref}${env === "production" ? "; approve it in GitHub Actions" : ""}.`
            : `\nCould not start ${d.workflow}: ${redact(r.stderr.trim(), values)}`,
        );
      }
    } else {
      out("\nVercel reads values when it deploys: run again with --redeploy, or deploy as usual.");
    }
  }
  out(
    failed
      ? `\n${failed} write(s) FAILED; fix the cause and run the same command again.`
      : "\nDone.",
  );
  return failed ? 1 : 0;
}

async function cmdList(opts, io) {
  const { out, run, targets, rows } = io;
  const all = planUpdate(
    rows,
    rows.map((r) => r.id),
    { env: opts.env, stores: opts.stores },
  );
  let held = null;
  if (opts.check) {
    held = new Map();
    const places = new Map();
    for (const g of all.groups) {
      for (const w of g.writes) {
        const where = w.store === "github-env" ? w.githubEnv : w.env;
        const k = `${w.store}|${where}`;
        if (!places.has(k)) places.set(k, { store: w.store, where, names: new Set() });
        places.get(k).names.add(w.name);
      }
    }
    for (const [k, p] of places) {
      try {
        const r = await run(listStep(p.store, p.where, targets));
        held.set(k, r.code === 0 ? new Set(parseNames(p.store, r.stdout, [...p.names])) : null);
      } catch {
        held.set(k, null);
      }
    }
  }
  let missing = 0;
  for (const g of all.groups) {
    out(`${g.logical} [${g.env}] (${g.rowId}) — ${g.title}`);
    for (const w of g.writes) {
      let mark = "  ";
      if (held) {
        const set = held.get(`${w.store}|${w.store === "github-env" ? w.githubEnv : w.env}`);
        mark = set == null ? "? " : set.has(w.name) ? "✓ " : "✗ ";
        if (set && !set.has(w.name)) missing++;
      }
      out(`   ${mark}${describeWrite(w)}`);
    }
  }
  if (held) {
    out(`\n✓ present  ✗ missing  ? could not read that store (run doctor)`);
    out(missing ? `${missing} name(s) missing.` : "Every listed name is present.");
  }
  return held && missing ? 1 : 0;
}

async function cmdDoctor(_opts, io) {
  const { out, run, targets } = io;
  let bad = 0;
  for (const d of doctorSteps(targets)) {
    const r = await run(d.step);
    const ok = d.ok(r);
    if (!ok) bad++;
    out(`${ok ? "ok    " : "NOT OK"} ${d.what}${ok ? "" : ` — fix: ${d.fix}`}`);
  }
  for (const [env, id] of Object.entries(targets.vercel.projects)) {
    if (!id || !targets.vercel.teamId) {
      bad++;
      out(`NOT OK Vercel ids for ${env} — fix: add them to ../praxis-secrets-targets.json`);
    }
  }
  return bad ? 1 : 0;
}

async function cmdLogin(_opts, io) {
  for (const step of loginSteps()) await io.run(step, { inherit: true });
  return cmdDoctor(_opts, io);
}

const HELP = readFileSync(new URL(import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("//   ") || l.startsWith("//       "))
  .map((l) => l.slice(3))
  .join("\n");

export async function main(argv, io) {
  const opts = parseCli(argv);
  const commands = { set: cmdSet, list: cmdList, doctor: cmdDoctor, login: cmdLogin };
  const fn = commands[opts.command];
  if (!fn) {
    io.out(HELP);
    return opts.command === "help" ? 0 : 1;
  }
  return fn(opts, io);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const prompter = makePrompter();
  main(process.argv.slice(2), {
    out: (s) => console.log(s),
    run: runStep,
    rows: loadRows(),
    targets: loadTargets(),
    prompter,
  })
    .then((code) => {
      prompter.close();
      process.exit(code);
    })
    .catch((e) => {
      console.error(`secrets: ${e.message}`);
      process.exit(1);
    });
}
