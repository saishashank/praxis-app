import assert from "node:assert/strict";
import { test } from "node:test";
import { checkQuarantine } from "./quarantine-check.mjs";

const good = {
  test: "tests/a.test.ts::flaky one",
  reason: "timing race under load",
  owner: "build",
  added: "2026-10-01",
  expires: "2026-10-03",
};
const opts = { today: "2026-10-02", exists: () => true };

test("empty list passes", () => {
  assert.deepEqual(checkQuarantine({ quarantined: [] }, opts), []);
});

test("a complete, unexpired entry within 2 days passes", () => {
  assert.deepEqual(checkQuarantine({ quarantined: [good] }, opts), []);
});

test("expiry day itself is still valid; the day after fails", () => {
  const e = { ...good, expires: "2026-10-02" };
  assert.deepEqual(checkQuarantine({ quarantined: [e] }, opts), []);
  const f = checkQuarantine({ quarantined: [e] }, { ...opts, today: "2026-10-03" });
  assert.match(f[0], /expired on 2026-10-02/);
});

test("missing reason or owner fails", () => {
  const f = checkQuarantine({ quarantined: [{ ...good, reason: " ", owner: undefined }] }, opts);
  assert.equal(f.filter((x) => /missing/.test(x)).length, 2);
});

test("expiry more than 2 days after added fails; exactly 2 passes", () => {
  assert.equal(
    checkQuarantine(
      { quarantined: [{ ...good, added: "2026-10-01", expires: "2026-10-03" }] },
      opts,
    ).length,
    0,
  );
  const f = checkQuarantine(
    { quarantined: [{ ...good, added: "2026-10-01", expires: "2026-10-04" }] },
    opts,
  );
  assert.match(f[0], /more than 2 days/);
});

test("bad dates, expires before added, duplicates and missing files fail", () => {
  assert.match(
    checkQuarantine({ quarantined: [{ ...good, expires: "soon" }] }, opts)[0],
    /expires must be/,
  );
  assert.match(
    checkQuarantine({ quarantined: [{ ...good, added: "2026-02-31" }] }, opts)[0],
    /added must be/,
  );
  assert.match(
    checkQuarantine({ quarantined: [{ ...good, expires: "2026-09-30" }] }, opts)[0],
    /before added/,
  );
  assert.match(checkQuarantine({ quarantined: [good, good] }, opts)[0], /duplicate/);
  assert.match(
    checkQuarantine({ quarantined: [good] }, { ...opts, exists: () => false })[0],
    /does not exist/,
  );
});

test("wrong top-level shape fails", () => {
  assert.equal(checkQuarantine({}, opts).length, 1);
  assert.equal(checkQuarantine(null, opts).length, 1);
});
