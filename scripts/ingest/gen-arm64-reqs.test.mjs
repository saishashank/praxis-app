import assert from "node:assert/strict";
import test from "node:test";
import { build, fileFits, parsePins, pickFiles } from "./gen-arm64-reqs.mjs";

test("parsePins: pinned lines only, comments and hash lines skipped", () => {
  const pins = parsePins(
    "# Direct requirement: yfinance==1.7.0\nNumpy==2.5.4 \\\n    --hash=sha256:aa\nyfinance==1.7.0 \\\n",
  );
  assert.deepEqual(pins, [
    { name: "numpy", version: "2.5.4" },
    { name: "yfinance", version: "1.7.0" },
  ]);
});

test("fileFits: CPython 3.12 on Linux aarch64 only", () => {
  assert.equal(
    fileFits("numpy-2.5.4-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl"),
    "binary",
  );
  assert.equal(fileFits("numpy-2.5.4-cp312-cp312-musllinux_1_2_aarch64.whl"), "binary");
  assert.equal(
    fileFits("curl_cffi-0.16.3-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl"),
    "binary",
  );
  assert.equal(fileFits("six-1.17.0-py2.py3-none-any.whl"), "pure");
  assert.equal(fileFits("numpy-2.5.4.tar.gz"), "sdist");
  assert.equal(fileFits("numpy-2.5.4-cp312-cp312-manylinux_2_17_x86_64.whl"), null);
  assert.equal(fileFits("numpy-2.5.4-cp313-cp313-manylinux_2_27_aarch64.whl"), null);
  assert.equal(fileFits("numpy-2.5.4-cp312-cp312-macosx_14_0_arm64.whl"), null);
  assert.equal(fileFits("numpy-2.5.4-cp312-cp312-win_arm64.whl"), null);
});

test("pickFiles: yanked files dropped, hashes de-duplicated and sorted", () => {
  const r = pickFiles([
    { filename: "a-1-py3-none-any.whl", digests: { sha256: "bb" } },
    { filename: "a-1.tar.gz", digests: { sha256: "aa" } },
    { filename: "a-1-py3-none-any.whl", digests: { sha256: "cc" }, yanked: true },
    { filename: "a-1-cp312-cp312-win_amd64.whl", digests: { sha256: "dd" } },
  ]);
  assert.deepEqual(r.hashes, ["aa", "bb"]);
  assert.deepEqual([...r.kinds].sort(), ["pure", "sdist"]);
});

test("build: sdist-only binary package is a problem; output keeps the pinned versions", async () => {
  const files = {
    "numpy/2.5.4": [
      { filename: "numpy-2.5.4-cp312-cp312-manylinux_2_27_aarch64.whl", digests: { sha256: "11" } },
    ],
    "oddpkg/1.0": [{ filename: "oddpkg-1.0.tar.gz", digests: { sha256: "22" } }],
  };
  const fakeFetch = async (url) => {
    const key = String(url).replace("https://pypi.org/pypi/", "").replace("/json", "");
    return new Response(JSON.stringify({ urls: files[key] ?? [] }), { status: 200 });
  };
  const { text, problems } = await build("numpy==2.5.4 \\\noddpkg==1.0 \\\n", fakeFetch);
  assert.match(text, /^numpy==2\.5\.4 \\\n {4}--hash=sha256:11$/m);
  assert.deepEqual(problems, ["oddpkg==1.0: only an sdist (no aarch64 wheel)"]);
});
