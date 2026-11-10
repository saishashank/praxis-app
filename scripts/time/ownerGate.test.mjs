// INFRA T1: the owner gate of the two scheduled GitHub backstops. No network, no real secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOCK_OWNER_KEY, ownerFrom, ownerGate } from "./ownerGate.mjs";

const ENV = { TURSO_MAIN_URL: "libsql://praxis-test.example.test", TURSO_MAIN_TOKEN: "t-fake" };
const answer =
  (value, status = 200) =>
  async (url, init) => {
    answer.last = { url, init };
    return new Response(
      JSON.stringify({
        results: [
          {
            type: "ok",
            response: {
              result: { rows: value === undefined ? [] : [[{ type: "text", value }]] },
            },
          },
          { type: "ok", response: { type: "close" } },
        ],
      }),
      { status },
    );
  };

test("ownerFrom: only the JSON string selfhost is selfhost", () => {
  assert.equal(ownerFrom('"selfhost"'), "selfhost");
  for (const v of [undefined, null, "", "selfhost", "{", '"cloud"', '"x"', "1", '["selfhost"]']) {
    assert.equal(ownerFrom(v), "cloud");
  }
});

test("key absent: runs (today's behaviour) and reads exactly one request", async () => {
  assert.deepEqual(await ownerGate(ENV, answer(undefined)), { run: true, owner: "cloud" });
  const body = JSON.parse(answer.last.init.body);
  assert.equal(answer.last.url, "https://praxis-test.example.test/v2/pipeline");
  assert.equal(body.requests[0].stmt.args[0].value, CLOCK_OWNER_KEY);
  assert.equal(body.requests.length, 2); // the one statement and the close
});

test('"cloud" runs; "selfhost" stands by', async () => {
  assert.deepEqual(await ownerGate(ENV, answer('"cloud"')), { run: true, owner: "cloud" });
  assert.deepEqual(await ownerGate(ENV, answer('"selfhost"')), { run: false, owner: "selfhost" });
});

test("a garbage value is cloud", async () => {
  assert.deepEqual(await ownerGate(ENV, answer("{oops")), { run: true, owner: "cloud" });
});

test("missing database config, an HTTP error or a thrown fetch all fail to cloud", async () => {
  const never = async () => assert.fail("must not call the network");
  assert.equal((await ownerGate({}, never)).run, true);
  assert.equal((await ownerGate({ TURSO_MAIN_URL: ENV.TURSO_MAIN_URL }, never)).run, true);
  assert.equal((await ownerGate({ ...ENV, TURSO_MAIN_URL: "http://x" }, never)).run, true);
  assert.equal((await ownerGate(ENV, answer('"selfhost"', 500))).run, true);
  const boom = async () => {
    throw new Error("secret-host-detail");
  };
  assert.deepEqual(await ownerGate(ENV, boom), { run: true, owner: "cloud" });
});
