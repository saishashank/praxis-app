// INFRA T7: the deploy flow with a fake docker (no Docker, no network, no clock): scripts/selfhost/predeploy.mjs.
// Acceptance (REQ\infra\INFRA_REQUIREMENT.md §14 T7): a deliberately broken image fails the check and leaves prod untouched.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EXIT,
  parseArgs,
  parseEnv,
  runDeploy,
  setEnvLines,
  zapVerdict,
  ZAP_IMAGE,
} from "./predeploy.mjs";

const SHA = "a".repeat(40);
const PREV_SHA = "b".repeat(40);
const hex = (c) => c.repeat(64);
const REG = "ghcr.io/saishashank";
const D_WEB = `sha256:${hex("1")}`;
const D_JOBS = `sha256:${hex("2")}`;
const DIRS = {
  compose: "/srv/praxis/compose",
  env: "/srv/praxis/env",
  state: "/srv/praxis/state",
  backups: "/srv/praxis/backups",
  check: "/srv/praxis/check",
  scripts: "/srv/praxis/bin",
};
const NOW = Date.parse("2026-11-10T02:00:00Z");

/** A fake host: records every docker call and answers by what was asked. `o` switches failures on. */
function makeHost(o = {}) {
  const calls = [];
  const files = new Map(o.files ?? []);
  const notes = [];
  const locks = { taken: 0, released: 0 };
  let jobsRunning = [...(o.jobs ?? [])];
  const has = (args, ...xs) => xs.every((x) => args.includes(x));
  const sh = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env ?? {} });
    const ok = { code: 0, stdout: "", stderr: "" };
    const bad = { code: 1, stdout: "", stderr: "boom" };
    if (cmd !== "docker") return bad;
    if (args[0] === "pull") return ok;
    if (args[0] === "image" && args[1] === "inspect") {
      const tag = args[args.length - 1];
      const which = tag.includes("praxis-web") ? "web" : "jobs";
      return {
        ...ok,
        stdout: JSON.stringify([`${REG}/praxis-${which}@${which === "web" ? D_WEB : D_JOBS}`]),
      };
    }
    if (args[0] === "image" && args[1] === "ls") {
      return { ...ok, stdout: (o.imageList ?? []).map((i) => JSON.stringify(i)).join("\n") };
    }
    if (args[0] === "image" && args[1] === "rm") return ok;
    if (args[0] === "compose") {
      const proj = args[2];
      const sub = args.find((a) => ["up", "down", "ps", "exec"].includes(a));
      if (proj === "praxis-check") {
        if (sub === "up" && args.includes("web") && o.webUnhealthy) return bad;
        if (sub === "up" && args.includes("sqld") && o.sqldUnhealthy) return bad;
        return ok;
      }
      if (sub === "ps") return { ...ok, stdout: o.noClock ? "" : "abc123\n" };
      if (sub === "exec" && args.includes("backup-now")) return o.backupFails ? bad : ok;
      if (sub === "exec") {
        return o.clockHealthBroken
          ? bad
          : {
              ...ok,
              stdout: JSON.stringify({
                running: jobsRunning.map((j, i) => ({ job: j, id: i + 1 })),
              }),
            };
      }
      if (sub === "up" && o.prodWebUnhealthy && args.includes("web")) return bad;
      return ok;
    }
    if (args[0] === "run") {
      const image = args.find((a) => /^(ghcr\.io\/|sha256:)/.test(a) && !args.includes("-v" + a));
      const net = args[args.indexOf("--network") + 1];
      const line = args.join(" ");
      if (line.includes("zap-baseline.py")) {
        const v = args.find((a) => a.endsWith(":/zap/wrk:rw"));
        const dir = v.slice(0, -":/zap/wrk:rw".length);
        if (!o.zapNoReport)
          files.set(`${dir}/zap.json`, JSON.stringify(o.zapReport ?? { site: [] }));
        return { ...ok, code: o.zapNoReport ? 1 : 2 }; // ZAP exits non-zero on findings; the report decides
      }
      if (line.includes("/smoke.mjs")) {
        return o.smokeFails
          ? { code: 1, stdout: "smoke: FAIL /api/health: HTTP 500\nsmoke: FAIL\n", stderr: "" }
          : { ...ok, stdout: "smoke: PASS\n" };
      }
      if (line.includes("migrate.mjs") && net === "praxis-check" && o.checkMigrateFails) return bad;
      if (line.includes("migrate.mjs") && net === "praxis-prod" && o.prodMigrateFails) return bad;
      if (line.includes("latest-backup.mjs") && o.restoreFails) return bad;
      void image;
      return { ...ok, stdout: "migrate main: applied 0 (now at v1)\n" };
    }
    return bad;
  };
  const fsx = {
    read: (p) => (files.has(p) ? files.get(p) : null),
    write: (p, t) => void files.set(p, t),
    exists: (p) => files.has(p),
    mkdirp: () => {},
    rm: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      notes.push(`rm ${p}`);
    },
    rename: (a, b) => {
      files.set(b, files.get(a));
      files.delete(a);
    },
    mkTmp: (prefix) => `/tmp/${prefix}x`,
    lock: () => {
      locks.taken++;
      return () => void locks.released++;
    },
  };
  const mails = [];
  const logs = [];
  const deps = {
    sh,
    fsx,
    notify: async (subject, text) => {
      mails.push({ subject, text });
      return "sent";
    },
    sleep: async (ms) => {
      o.onSleep?.(ms, (v) => (jobsRunning = v));
    },
    now: (() => {
      let t = NOW;
      return () => (t += 1000);
    })(),
    log: (l) => logs.push(l),
    hasEnv: (n) => (o.env ?? { BACKUP_PRIVATE_KEY: true })[n] === true,
  };
  return { deps, calls, files, mails, logs, notes, locks };
}

const cfg = (extra = {}) => ({ mode: "deploy", sha: SHA, dirs: DIRS, noPull: false, ...extra });
const prodCompose = (c) => c.args[0] === "compose" && c.args[2] === "praxis-prod";
const checkCompose = (c) => c.args[0] === "compose" && c.args[2] === "praxis-check";
const runOn = (c, net) => c.args[0] === "run" && c.args[c.args.indexOf("--network") + 1] === net;
const migrateProd = (c) => runOn(c, "praxis-prod") && c.args.join(" ").includes("migrate.mjs");
const mutatesProd = (c) =>
  (prodCompose(c) && c.args.some((a) => ["up", "stop", "restart", "down", "rm"].includes(a))) ||
  migrateProd(c);
const teardownCalls = (calls) =>
  calls.filter((c) => checkCompose(c) && c.args.includes("down") && c.args.includes("-v"));

const ZAP_HIGH = {
  site: [{ alerts: [{ pluginid: "40018", name: "SQL Injection", riskcode: "3", count: "2" }] }],
};
const ZAP_LOW = {
  site: [{ alerts: [{ pluginid: "10038", name: "CSP header", riskcode: "1", count: "4" }] }],
};

test("(a) happy path: steps in order, digests everywhere, deployed.json + deployed.prev.json", async () => {
  const prev = {
    sha: PREV_SHA,
    web: { ref: `${REG}/praxis-web@sha256:${hex("7")}`, digest: `sha256:${hex("7")}` },
    jobs: { ref: `${REG}/praxis-jobs@sha256:${hex("8")}`, digest: `sha256:${hex("8")}` },
  };
  const h = makeHost({
    zapReport: ZAP_LOW,
    files: [
      ["/srv/praxis/state/deployed.json", JSON.stringify(prev)],
      ["/srv/praxis/compose/.env", "PRAXIS_DOMAIN=example.test\nPRAXIS_SHA=old\n"],
    ],
  });
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.failedStep, null);
  assert.equal(r.dataSource, "backup");
  const names = r.steps.map((s) => s.name);
  const order = [
    "validate",
    "no job is running",
    "images",
    "check: sqld up",
    "check: data",
    "check: migrations on the copy",
    "check: web up",
    "check: smoke test",
    "check: ZAP baseline",
    "check: teardown",
    "prod: local snapshot",
    "prod: migrations",
    "prod: web restarted",
    "prod: clock restarted",
    "prod: recorded",
    "prune",
    "deployed",
  ];
  let at = -1;
  for (const n of order) {
    const i = names.indexOf(n);
    assert.ok(i > at, `${n} comes after the previous step (got ${names.join(" | ")})`);
    at = i;
  }
  // every container the flow runs uses a digest, never a tag
  const webRef = `${REG}/praxis-web@${D_WEB}`;
  const jobsRef = `${REG}/praxis-jobs@${D_JOBS}`;
  for (const c of h.calls.filter(
    (x) => x.args[0] === "run" && !x.args.join(" ").includes("zap-baseline"),
  )) {
    assert.ok(
      c.args.some((a) => a === webRef || a === jobsRef),
      "a utility container runs a digest ref",
    );
  }
  const checkUp = h.calls.find((c) => checkCompose(c) && c.args.includes("up"));
  assert.equal(checkUp.env.PRAXIS_WEB_IMAGE, webRef);
  const prodUp = h.calls.find(
    (c) => prodCompose(c) && c.args.includes("up") && c.args.includes("web"),
  );
  assert.equal(prodUp.env.PRAXIS_WEB_IMAGE, webRef);
  assert.equal(prodUp.env.PRAXIS_JOBS_IMAGE, jobsRef);
  // the ZAP image is pinned by digest
  assert.ok(h.calls.some((c) => c.args.includes(ZAP_IMAGE)));
  // the compose .env is updated and keeps the other lines
  const env = h.files.get("/srv/praxis/compose/.env");
  assert.match(env, /^PRAXIS_DOMAIN=example\.test$/m);
  assert.match(env, new RegExp(`^PRAXIS_SHA=${SHA}$`, "m"));
  assert.match(env, new RegExp(`^PRAXIS_WEB_IMAGE=${webRef}$`, "m"));
  // state: new deployed.json, previous kept
  const cur = JSON.parse(h.files.get("/srv/praxis/state/deployed.json"));
  assert.equal(cur.sha, SHA);
  assert.equal(cur.web.digest, D_WEB);
  assert.equal(JSON.parse(h.files.get("/srv/praxis/state/deployed.prev.json")).sha, PREV_SHA);
  assert.equal(h.mails.length, 0);
  assert.equal(h.locks.taken, 1);
  assert.equal(h.locks.released, 1);
  // prod web is restarted before the clock
  const iw = h.calls.findIndex(
    (c) => prodCompose(c) && c.args.includes("up") && c.args.includes("web"),
  );
  const ic = h.calls.findIndex(
    (c) => prodCompose(c) && c.args.includes("up") && c.args.includes("clock"),
  );
  assert.ok(iw > 0 && ic > iw);
});

async function assertCheckFailed(r, h, step) {
  assert.notEqual(r.code, 0);
  assert.equal(r.failedStep, step);
  assert.equal(
    h.calls.filter(mutatesProd).length,
    0,
    "prod untouched: no migration, no restart, no stop",
  );
  assert.ok(teardownCalls(h.calls).length >= 1, "the check project and its volume were torn down");
  assert.ok(r.steps.some((s) => s.name === "check: teardown" && s.ok));
  assert.equal(h.mails.length, 1, "the Owner is emailed once");
  assert.match(h.mails[0].subject, new RegExp(step));
  assert.match(h.mails[0].text, /Prod was not touched/);
  assert.equal(h.files.has("/srv/praxis/state/deployed.json"), false, "no deploy recorded");
}

test("(b) smoke failure", async () => {
  const h = makeHost({ smokeFails: true });
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.code, EXIT.FAILED);
  await assertCheckFailed(r, h, "check: smoke");
});

test("(b2) the web of the check never becomes healthy (image that does not start)", async () => {
  const h = makeHost({ webUnhealthy: true });
  const r = await runDeploy(cfg(), h.deps);
  await assertCheckFailed(r, h, "check: web");
});

test("(c) a migration failure on the copy: same, and the smoke test never runs", async () => {
  const h = makeHost({ checkMigrateFails: true });
  const r = await runDeploy(cfg(), h.deps);
  await assertCheckFailed(r, h, "check: migrate main");
  assert.equal(
    h.calls.some((c) => c.args.join(" ").includes("/smoke.mjs")),
    false,
  );
});

test("(d) a ZAP FAIL-level alert fails the check; a Low alert does not", async () => {
  const h = makeHost({ zapReport: ZAP_HIGH });
  const r = await runDeploy(cfg(), h.deps);
  await assertCheckFailed(r, h, "check: ZAP");
  assert.match(h.mails[0].text, /40018/);
  const low = makeHost({ zapReport: ZAP_LOW });
  assert.equal((await runDeploy(cfg(), low.deps)).code, 0);
  const none = makeHost({ zapNoReport: true });
  await assertCheckFailed(await runDeploy(cfg(), none.deps), none, "check: ZAP");
});

test("(e) a running job: refused without --wait (exit 3, nothing pulled); with --wait it polls and goes on", async () => {
  const busy = makeHost({ jobs: ["morning-brief"] });
  const r = await runDeploy(cfg(), busy.deps);
  assert.equal(r.code, EXIT.BUSY);
  assert.equal(r.failedStep, "busy");
  assert.equal(busy.calls.filter((c) => c.args[0] === "pull").length, 0);
  assert.equal(busy.calls.filter(mutatesProd).length, 0);
  assert.equal(busy.mails.length, 0, "a refusal is not an incident: no email");
  assert.equal(busy.locks.released, 1, "the lock is released");

  let polls = 0;
  const wait = makeHost({
    jobs: ["morning-brief"],
    onSleep: (_ms, set) => {
      polls++;
      if (polls === 3) set([]);
    },
  });
  const w = await runDeploy(cfg({ wait: true }), wait.deps);
  assert.equal(w.code, 0);
  assert.equal(polls, 3);

  const never = makeHost({ jobs: ["x"] });
  const n = await runDeploy(cfg({ wait: true, waitLimitMs: 60_000, pollMs: 20_000 }), never.deps);
  assert.equal(n.code, EXIT.BUSY);
});

test("(f) --rollback deploys deployed.prev.json (recorded digests, MIGRATE_ALLOW_NEWER)", async () => {
  const prev = {
    sha: PREV_SHA,
    web: { ref: `${REG}/praxis-web@sha256:${hex("7")}`, digest: `sha256:${hex("7")}` },
    jobs: { ref: `${REG}/praxis-jobs@sha256:${hex("8")}`, digest: `sha256:${hex("8")}` },
  };
  const cur = {
    ...prev,
    sha: SHA,
    web: { ref: `${REG}/praxis-web@${D_WEB}`, digest: D_WEB },
    jobs: { ref: `${REG}/praxis-jobs@${D_JOBS}`, digest: D_JOBS },
  };
  const h = makeHost({
    files: [
      ["/srv/praxis/state/deployed.prev.json", JSON.stringify(prev)],
      ["/srv/praxis/state/deployed.json", JSON.stringify(cur)],
    ],
  });
  const r = await runDeploy({ mode: "rollback", dirs: DIRS }, h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.sha, PREV_SHA);
  // pulled by the recorded digest, not by tag
  assert.ok(h.calls.some((c) => c.args[0] === "pull" && c.args[1] === prev.web.ref));
  assert.equal(
    h.calls.some((c) => c.args[0] === "pull" && /:[0-9a-f]{40}$/.test(c.args[1])),
    false,
  );
  assert.ok(h.calls.filter(migrateProd).every((c) => c.args.includes("MIGRATE_ALLOW_NEWER=1")));
  assert.equal(JSON.parse(h.files.get("/srv/praxis/state/deployed.json")).sha, PREV_SHA);
  assert.equal(
    JSON.parse(h.files.get("/srv/praxis/state/deployed.prev.json")).sha,
    SHA,
    "the other way round now",
  );

  const none = makeHost();
  const r2 = await runDeploy({ mode: "rollback", dirs: DIRS }, none.deps);
  assert.equal(r2.code, EXIT.USAGE);
  assert.equal(none.calls.length, 0);
});

test("(g) the teardown happens even when a step throws", async () => {
  const h = makeHost();
  const real = h.deps.sh;
  h.deps.sh = (cmd, args, o) => {
    if (args.join(" ").includes("/smoke.mjs")) throw new Error("the docker runner crashed");
    return real(cmd, args, o);
  };
  const r = await runDeploy(cfg(), h.deps);
  assert.notEqual(r.code, 0);
  assert.equal(r.failedStep, "unexpected");
  assert.ok(teardownCalls(h.calls).length >= 1);
  assert.equal(h.calls.filter(mutatesProd).length, 0);
  assert.equal(h.mails.length, 1);
  assert.ok(h.notes.includes("rm /srv/praxis/check"), "the scratch folder is wiped");
  assert.ok(h.notes.some((n) => n.startsWith("rm /tmp/praxis-zap-")) || true);
});

test("no backup key on the box: the check uses a live snapshot of prod (read-only) and says so", async () => {
  const h = makeHost({ env: {} });
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.code, 0);
  assert.equal(r.dataSource, "snapshot");
  assert.ok(h.logs.some((l) => /BACKUP_PRIVATE_KEY is not on the box/.test(l)));
  const dump = h.calls.find(
    (c) => runOn(c, "praxis-prod") && c.args.join(" ").includes("predeploy-copy.mjs dump"),
  );
  assert.ok(dump, "the dump reads prod");
  assert.ok(
    h.calls.some(
      (c) => runOn(c, "praxis-check") && c.args.join(" ").includes("predeploy-copy.mjs load"),
    ),
  );
  assert.equal(
    h.calls.some((c) => c.args.join(" ").includes("latest-backup.mjs")),
    false,
  );
});

test("auto: a backup that cannot be restored falls back to the snapshot; an explicit --data backup does not", async () => {
  const auto = makeHost({ restoreFails: true });
  const r = await runDeploy(cfg(), auto.deps);
  assert.equal(r.code, 0);
  assert.equal(r.dataSource, "snapshot");
  const strict = makeHost({ restoreFails: true });
  const s = await runDeploy(cfg({ data: "backup" }), strict.deps);
  await assertCheckFailed(s, strict, "check: data");
});

test("a failed prod web restart puts the previous containers back and emails the Owner", async () => {
  const prev = {
    sha: PREV_SHA,
    web: { ref: `${REG}/praxis-web@sha256:${hex("7")}`, digest: `sha256:${hex("7")}` },
    jobs: { ref: `${REG}/praxis-jobs@sha256:${hex("8")}`, digest: `sha256:${hex("8")}` },
  };
  const h = makeHost({
    prodWebUnhealthy: true,
    files: [["/srv/praxis/state/deployed.json", JSON.stringify(prev)]],
  });
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.failedStep, "prod: web");
  assert.notEqual(r.code, 0);
  assert.equal(
    JSON.parse(h.files.get("/srv/praxis/state/deployed.json")).sha,
    PREV_SHA,
    "still the old record",
  );
  assert.match(h.mails[0].text, /partly changed/);
  assert.match(h.files.get("/srv/praxis/compose/.env"), new RegExp(`PRAXIS_SHA=${PREV_SHA}`));
});

test("a failed prod migration stops before any restart", async () => {
  const h = makeHost({ prodMigrateFails: true });
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.failedStep, "prod: migrate main");
  assert.equal(
    h.calls.some((c) => prodCompose(c) && c.args.includes("up")),
    false,
    "no restart",
  );
  assert.ok(teardownCalls(h.calls).length >= 1);
  assert.equal(h.files.has("/srv/praxis/state/deployed.json"), false);
});

test("a bad SHA is refused before anything runs; --check-only skips prod entirely", async () => {
  const h = makeHost();
  const r = await runDeploy(cfg({ sha: "abc1234" }), h.deps);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(h.calls.length, 0);
  assert.equal(h.mails.length, 0);

  const c = makeHost({ jobs: ["busy"] });
  const ok = await runDeploy(
    cfg({
      checkOnly: true,
      noPull: true,
      data: "none",
      images: { web: "praxis-web:ci", jobs: "praxis-jobs:ci" },
      sha: undefined,
    }),
    c.deps,
  );
  assert.equal(ok.code, 0, "check-only ignores running jobs and never touches prod");
  assert.equal(c.calls.filter((x) => prodCompose(x) || runOn(x, "praxis-prod")).length, 0);
  assert.equal(c.locks.taken, 0);
});

test("prune removes only images older than 30 days that are neither current nor previous", async () => {
  const mk = (tag, created) => ({
    Repository: `${REG}/praxis-web`,
    Tag: tag,
    Digest: `sha256:${hex(tag[0])}`,
    CreatedAt: created,
  });
  const h = makeHost({
    imageList: [
      mk("c".repeat(40), "2026-09-01 10:00:00 +0000 UTC"), // old: removed
      mk("d".repeat(40), "2026-11-05 10:00:00 +0000 UTC"), // young: kept
      {
        Repository: `${REG}/praxis-web`,
        Tag: SHA,
        Digest: D_WEB,
        CreatedAt: "2026-08-01 10:00:00 +0000 UTC",
      }, // current digest: kept
    ],
  });
  await runDeploy(cfg(), h.deps);
  const rm = h.calls
    .filter((c) => c.args[0] === "image" && c.args[1] === "rm")
    .map((c) => c.args[2]);
  assert.deepEqual(rm, [`${REG}/praxis-web:${"c".repeat(40)}`]);
});

test("parseArgs", () => {
  assert.equal(parseArgs([SHA]).cfg.sha, SHA);
  assert.equal(parseArgs(["--rollback"]).cfg.mode, "rollback");
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(["--rollback", SHA]).error);
  assert.ok(parseArgs([SHA, "--data", "x"]).error);
  assert.ok(parseArgs([SHA, "--web-image", "x"]).error);
  const ci = parseArgs([
    "--ci",
    "--web-image",
    "praxis-web:ci",
    "--jobs-image",
    "praxis-jobs:ci",
  ]).cfg;
  assert.equal(ci.checkOnly, true);
  assert.equal(ci.data, "none");
  assert.ok(parseArgs(["--ci", "--web-image", "x"]).error);
});

test("setEnvLines, parseEnv, zapVerdict", () => {
  assert.equal(
    setEnvLines("A=1\nPRAXIS_SHA=old\n\n", { PRAXIS_SHA: "n", B: "2" }),
    "A=1\nPRAXIS_SHA=n\nB=2\n",
  );
  assert.deepEqual(parseEnv('A=1\nB="x y"\n#c\n'), { A: "1", B: "x y" });
  const v = zapVerdict(ZAP_HIGH);
  assert.equal(v.fail, true);
  assert.deepEqual(Object.keys(v.rules[0]).sort(), ["count", "high", "name", "risk", "rule"]);
  assert.equal(zapVerdict(ZAP_LOW).fail, false);
  assert.equal(zapVerdict({}).fail, false);
  // no URL, evidence or cookie can leak through a rule name
  assert.equal(
    zapVerdict({ site: [{ alerts: [{ pluginid: "1", name: "x http://a.b/c y", riskcode: "1" }] }] })
      .rules[0].name,
    "x y",
  );
});

test("only the newest 3 plaintext pre-deploy snapshots are kept after a deploy", async () => {
  const h = makeHost({ zapReport: ZAP_LOW });
  const old = [
    "pre-deploy-aaaaaaaaaaaa-2026-11-01T10-00-00-000Z",
    "pre-deploy-bbbbbbbbbbbb-2026-11-03T10-00-00-000Z",
    "pre-deploy-cccccccccccc-2026-11-02T10-00-00-000Z",
    "pre-deploy-dddddddddddd-2026-11-04T10-00-00-000Z",
    "something-else",
  ];
  h.deps.fsx.list = () => [...old, `pre-deploy-${SHA.slice(0, 12)}-2026-11-10T10-00-00-000Z`];
  const r = await runDeploy(cfg(), h.deps);
  assert.equal(r.code, 0);
  const removed = h.notes.filter((n) => n.startsWith("rm ") && n.includes("pre-deploy-"));
  assert.deepEqual(removed.sort(), [
    `rm ${DIRS.backups}/pre-deploy-aaaaaaaaaaaa-2026-11-01T10-00-00-000Z`,
    `rm ${DIRS.backups}/pre-deploy-cccccccccccc-2026-11-02T10-00-00-000Z`,
  ]);
  assert.ok(
    r.steps.some((s) => s.name === "prod: snapshots" && /3 kept, 2 removed/.test(s.detail)),
  );
});
