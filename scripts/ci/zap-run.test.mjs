// M8 T12: the ZAP runner's argument building and refusals (no Docker, no network, no secret).
import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_PATTERN, dockerArgs, main } from "./zap-run.mjs";

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

test("the staging cookie is one -z argument, a header replacer rule, and nothing else carries it", () => {
  const a = dockerArgs({
    image: DIGEST,
    target: "https://staging.example.test",
    outDir: "/o",
    cookie: COOKIE,
  });
  const z = a[a.indexOf("-z") + 1];
  assert.match(z, /replacer\.full_list\(0\)\.matchtype=REQ_HEADER/);
  assert.match(z, /matchstr=Cookie/);
  assert.ok(z.endsWith(`replacement=${COOKIE}`));
  assert.equal(a.filter((x) => x.includes("eyJhbGciOi")).length, 1);
  assert.ok(!a.includes("--network"));
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
    assert.equal(await main(["staging"], { ZAP_IMAGE: "ghcr.io/zaproxy/zaproxy:stable" }), 2);
    assert.equal(
      await main(["staging"], { ZAP_IMAGE: DIGEST, ZAP_OUT: "/nonexistent-zap-out" }),
      2,
    );
  } finally {
    console.log = log;
  }
  assert.doesNotMatch(lines.join("\n"), /https?:|session/);
});
