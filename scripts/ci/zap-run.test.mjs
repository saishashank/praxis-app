// M8 T12: the ZAP runner's argument building and refusals (no Docker, no network, no secret).
// M18 OPS-107 / D-964: the scan is the LOCAL build, authenticated as the viewer test identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { decode } from "next-auth/jwt";
import { IMAGE_PATTERN, VIEWER, dockerArgs, main, mintViewerCookie } from "./zap-run.mjs";

const DIGEST = `ghcr.io/zaproxy/zaproxy@sha256:${"ab".repeat(32)}`;
const COOKIE = "__Secure-authjs.session-token=eyJhbGciOi.abc_def-123";

test("the image must be pinned by digest and come from the ZAP project", () => {
  assert.match(DIGEST, IMAGE_PATTERN);
  for (const bad of [
    "ghcr.io/zaproxy/zaproxy:stable",
    "ghcr.io/zaproxy/zaproxy@sha256:abc",
    `docker.io/other/zap@sha256:${"ab".repeat(32)}`,
    "",
  ]) {
    assert.doesNotMatch(bad, IMAGE_PATTERN);
    assert.throws(() => dockerArgs({ image: bad, target: "http://x", outDir: "/o" }));
  }
});

test("the local scan uses the host network and no cookie", () => {
  const a = dockerArgs({
    image: DIGEST,
    target: "http://127.0.0.1:3100",
    outDir: "/o",
    hostNetwork: true,
  });
  assert.deepEqual(a.slice(0, 4), ["run", "--rm", "--network", "host"]);
  assert.ok(a.includes("zap-baseline.py") && a.includes("-J") && a.includes("-I"));
  assert.ok(!a.includes("-z"));
  assert.ok(a.indexOf(DIGEST) < a.indexOf("zap-baseline.py"));
});

test("the viewer cookie is one -z argument, a header replacer rule, and nothing else carries it", () => {
  const a = dockerArgs({
    image: DIGEST,
    target: "http://127.0.0.1:3100",
    outDir: "/o",
    cookie: COOKIE,
    hostNetwork: true,
  });
  const z = a[a.indexOf("-z") + 1];
  assert.match(z, /replacer\.full_list\(0\)\.matchtype=REQ_HEADER/);
  assert.match(z, /matchstr=Cookie/);
  assert.ok(z.endsWith(`replacement=${COOKIE}`));
  assert.equal(a.filter((x) => x.includes("eyJhbGciOi")).length, 1);
});

test("an odd cookie shape is refused rather than passed to ZAP", () => {
  for (const bad of [
    "session=abc",
    "authjs.session-token=a b",
    "authjs.session-token=a;b",
    "authjs.session-token=",
  ]) {
    assert.throws(() =>
      dockerArgs({ image: DIGEST, target: "https://x", outDir: "/o", cookie: bad }),
    );
  }
});

test("main refuses a missing mode or an unpinned image and prints fixed sentences", async () => {
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    assert.equal(await main([], { ZAP_IMAGE: DIGEST }), 2);
    assert.equal(await main(["local"], { ZAP_IMAGE: "ghcr.io/zaproxy/zaproxy:stable" }), 2);
    // there is no staging scan any more (D-964)
    assert.equal(await main(["staging"], { ZAP_IMAGE: DIGEST }), 2);
    assert.equal(await main(["local", "extra-mode"], { ZAP_IMAGE: "" }), 2);
  } finally {
    console.log = log;
  }
  assert.doesNotMatch(lines.join("\n"), /https?:|session/);
});

// The authenticated local scan (AT-84): the cookie is minted for the seeded viewer with the claims the
// test-identity login handler issues, and the scan refuses to run without that user.
async function authDb(users) {
  const dir = mkdtempSync(path.join(tmpdir(), "zap-auth-"));
  const url = pathToFileURL(path.join(dir, "auth.db")).href;
  const db = createClient({ url });
  await db.execute(
    "CREATE TABLE app_user (id INTEGER PRIMARY KEY, email TEXT, status TEXT, session_version INTEGER)",
  );
  for (const [id, email, status, sv] of users) {
    await db.execute({
      sql: "INSERT INTO app_user (id, email, status, session_version) VALUES (?, ?, ?, ?)",
      args: [id, email, status, sv],
    });
  }
  db.close();
  return { url, dir };
}

test("mintViewerCookie: a session for the seeded viewer that the app can decode, accepted by the ZAP rule", async () => {
  const { url, dir } = await authDb([
    [1, "owner@praxis.test", "active", 1],
    [7, VIEWER, "active", 3],
  ]);
  try {
    const authSecret = "ab".repeat(32);
    const cookie = await mintViewerCookie({ authDbUrl: url, authSecret, nowSec: 1_800_000_000 });
    assert.match(cookie, /^authjs\.session-token=[\w.%~+/=-]+$/);
    const token = await decode({
      token: cookie.slice(cookie.indexOf("=") + 1),
      secret: authSecret,
      salt: "authjs.session-token",
    });
    assert.deepEqual(
      { uid: token.uid, sv: token.sv, si: token.si, rec: token.rec },
      { uid: 7, sv: 3, si: 1_800_000_000, rec: false },
    );
    // the same string passes the docker argument check
    const a = dockerArgs({
      image: DIGEST,
      target: "http://127.0.0.1:3100",
      outDir: "/o",
      cookie,
      hostNetwork: true,
    });
    assert.ok(a.includes("-z"));
  } finally {
    cleanup(dir);
  }
});

test("mintViewerCookie: no active viewer means no cookie (the scan would be unauthenticated)", async () => {
  const { url, dir } = await authDb([
    [1, "owner@praxis.test", "active", 1],
    [7, VIEWER, "disabled", 1],
  ]);
  try {
    await assert.rejects(
      mintViewerCookie({ authDbUrl: url, authSecret: "cd".repeat(32) }),
      /not seeded/,
    );
  } finally {
    cleanup(dir);
  }
});

// Best effort: Windows can keep a just-closed libSQL file locked for a moment; the run temp folder
// (scripts/test/with-run-temp.mjs) is removed at the end of the run anyway.
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* locked file, removed with the run temp folder */
  }
}
