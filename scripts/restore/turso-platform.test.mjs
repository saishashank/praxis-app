// M8 T7: the Turso Platform API client, with an injected fake fetch (no network, no real token).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTursoPlatform, throwawayName, TursoError } from "./turso-platform.mjs";

const TOKEN = "fake-platform-token-AAAA1111";

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ status, json: async () => body });

test("createDatabase posts name and group to the fixed host, returns name and libsql URL", async () => {
  const f = fakeFetch(() => json(200, { database: { Hostname: "drill-main-ab12-org.turso.io" } }));
  const api = createTursoPlatform({ org: "my-org", token: TOKEN, group: "default", fetchImpl: f });
  const db = await api.createDatabase("drill-main-ab12cd34");
  assert.deepEqual(db, {
    name: "drill-main-ab12cd34",
    url: "libsql://drill-main-ab12-org.turso.io",
  });
  const c = f.calls[0];
  assert.equal(c.url, "https://api.turso.tech/v1/organizations/my-org/databases");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.redirect, "error");
  assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(c.init.body), { name: "drill-main-ab12cd34", group: "default" });
});

test("deleteDatabase: 200, 204 and 404 count as deleted; other statuses throw status only", async () => {
  for (const status of [200, 204, 404]) {
    const f = fakeFetch(() => json(status, {}));
    await createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: f }).deleteDatabase(
      "drill-auth-x1y2",
    );
    assert.equal(f.calls[0].init.method, "DELETE");
    assert.equal(
      f.calls[0].url,
      "https://api.turso.tech/v1/organizations/o/databases/drill-auth-x1y2",
    );
  }
  const f = fakeFetch(() => json(500, { error: `secret ${TOKEN}` }));
  await assert.rejects(
    createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: f }).deleteDatabase("drill-auth-x1y2"),
    (e) => e instanceof TursoError && e.message === "turso delete_database failed (HTTP 500)",
  );
});

test("createDatabaseToken asks for a short expiry and returns the jwt", async () => {
  const f = fakeFetch(() => json(200, { jwt: "jwt-value" }));
  const api = createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: f });
  assert.equal(await api.createDatabaseToken("drill-main-aaaa1111"), "jwt-value");
  assert.match(
    f.calls[0].url,
    /\/drill-main-aaaa1111\/auth\/tokens\?expiration=1h&authorization=full-access$/,
  );
  await assert.rejects(api.createDatabaseToken("drill-main-aaaa1111", "forever"), TursoError);
});

test("errors never contain the token, a URL or a response body", async () => {
  const boom = fakeFetch(() => {
    throw new Error(`connect failed to https://api.turso.tech with ${TOKEN}`);
  });
  const api = createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: boom });
  for (const p of [
    api.createDatabase("drill-main-aaaa1111"),
    api.deleteDatabase("drill-main-aaaa1111"),
    api.createDatabaseToken("drill-main-aaaa1111"),
  ]) {
    await assert.rejects(p, (e) => {
      assert.ok(e instanceof TursoError);
      assert.doesNotMatch(e.message, /https?:|turso\.tech|fake-platform/);
      return true;
    });
  }
});

test("a server-chosen hostname outside turso.io is refused; bad names and orgs are refused", async () => {
  const evil = fakeFetch(() => json(200, { database: { Hostname: "evil.example.com" } }));
  await assert.rejects(
    createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: evil }).createDatabase(
      "drill-main-aaaa1111",
    ),
    TursoError,
  );
  const f = fakeFetch(() => json(200, {}));
  const api = createTursoPlatform({ org: "o", token: TOKEN, fetchImpl: f });
  await assert.rejects(api.deleteDatabase("../x"), TursoError);
  await assert.rejects(api.deleteDatabase("Prod"), TursoError);
  assert.equal(f.calls.length, 0);
  assert.throws(() => createTursoPlatform({ org: "a/b", token: TOKEN }), /misconfigured/);
  assert.throws(() => createTursoPlatform({ org: "o", token: "" }), /misconfigured/);
});

test("throwawayName builds only drill-/restore- names", () => {
  assert.equal(throwawayName("main", "ab12cd34"), "drill-main-ab12cd34");
  assert.equal(throwawayName("auth", "20260102ab12", "restore"), "restore-auth-20260102ab12");
  assert.throws(() => throwawayName("main", "AB"), /bad throwaway/);
  assert.throws(() => throwawayName("main", "ab12cd34", "prod"), /bad throwaway/);
});
