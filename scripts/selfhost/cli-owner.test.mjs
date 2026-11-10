// Review S1: `praxis owner` reads the OTHER database before it writes one (two-database cross-check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../../clock/cli.mjs";

/** Two fake databases; a reading that throws stands for an unreachable one. */
function fake(state) {
  const writes = [];
  const logs = [];
  const io = {
    log: (t) => logs.push(t),
    pipe: async (stmts, which = "local") => {
      if (state[which] === "down") throw new Error("down");
      return stmts.map((s) => {
        if (/^SELECT value_json/.test(s.sql)) {
          return state[which] === undefined ? [] : [[JSON.stringify(state[which])]];
        }
        if (/^SELECT/.test(s.sql)) return [[null, null]];
        writes.push([which, JSON.parse(s.args[1])]);
        state[which] = JSON.parse(s.args[1]);
        return [];
      });
    },
  };
  return { io, writes, logs };
}

test("owner selfhost (sqld) is refused unless Turso already says selfhost", async () => {
  for (const turso of ["cloud", undefined, "down"]) {
    const f = fake({ local: "cloud", turso });
    assert.equal(await owner("selfhost", {}, f.io), 1);
    assert.match(f.logs[0], /refused: the Turso copy does not say selfhost/);
    assert.deepEqual(f.writes, []);
  }
  const ok = fake({ local: "cloud", turso: "selfhost" });
  assert.equal(await owner("selfhost", {}, ok.io), 0);
  assert.deepEqual(ok.writes, [["local", "selfhost"]]);
});

test("owner cloud --turso is refused unless sqld already says cloud", async () => {
  for (const local of ["selfhost", "down"]) {
    const f = fake({ local, turso: "selfhost" });
    assert.equal(await owner("cloud", { turso: true }, f.io), 1);
    assert.match(f.logs[0], /refused: sqld does not say cloud/);
    assert.deepEqual(f.writes, []);
  }
  const ok = fake({ local: "cloud", turso: "selfhost" });
  assert.equal(await owner("cloud", { turso: true }, ok.io), 0);
  assert.deepEqual(ok.writes, [["turso", "cloud"]]);
});

test("the other steps need no cross-check, and --force skips it", async () => {
  const a = fake({ local: "selfhost", turso: "cloud" });
  assert.equal(await owner("selfhost", { turso: true }, a.io), 0); // cutover step 2
  assert.deepEqual(a.writes, [["turso", "selfhost"]]);
  const b = fake({ local: "selfhost", turso: "selfhost" });
  assert.equal(await owner("cloud", {}, b.io), 0); // switch-back step 1
  assert.deepEqual(b.writes, [["local", "cloud"]]);
  const c = fake({ local: "cloud", turso: "cloud" });
  assert.equal(await owner("selfhost", { force: true }, c.io), 0);
  const d = fake({ local: "selfhost", turso: "selfhost" });
  assert.equal(await owner("cloud", { turso: true, force: true }, d.io), 0);
});
