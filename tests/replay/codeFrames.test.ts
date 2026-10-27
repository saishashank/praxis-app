// @vitest-environment node
// D-188: a failed replay names its stage and the code locations, never the error message.
import { describe, expect, it } from "vitest";
import { causeCode, codeFrames } from "@/lib/replay/cli";

describe("codeFrames", () => {
  it("keeps our bundle's frames (function:file:line), skips other packages and Node", () => {
    const e = new TypeError("fetch failed for https://secret.example/db?token=abc");
    e.stack = [
      "TypeError: fetch failed for https://secret.example/db?token=abc",
      "    at node:internal/deps/undici/undici:13510:13",
      "    at fetchImpl (/home/runner/work/app/node_modules/undici/lib/fetch.js:10:5)",
      "    at putAsset (/home/runner/work/app/node_modules/.cache/praxis-replay/123-ab/cli.js:4652:29)",
      "    at async replayMain (/home/runner/work/app/node_modules/.cache/praxis-replay/123-ab/cli.js:9001:7)",
      "    at file:///C:/x/out/dbg.mjs:12:1",
      "    at another (src/lib/replay/runner.ts:300:2)",
    ].join("\n");
    const out = codeFrames(e);
    expect(out).toBe(" at=putAsset:cli.js:4652,replayMain:cli.js:9001,?:dbg.mjs:12");
    expect(out).not.toMatch(/secret|token|https/);
  });

  it("says nothing without a stack or for a non-error", () => {
    const e = new Error("x");
    e.stack = undefined;
    expect(codeFrames(e)).toBe("");
    expect(codeFrames("boom")).toBe("");
  });
});

describe("causeCode (D-198)", () => {
  it("names a network cause by its fixed code only", () => {
    const e = new TypeError("fetch failed", {
      cause: { code: "UND_ERR_SOCKET", host: "secret.example" },
    });
    expect(causeCode(e)).toBe(" cause=UND_ERR_SOCKET");
  });

  it("says nothing for a missing, odd or free-text code", () => {
    expect(causeCode(new TypeError("x"))).toBe("");
    expect(causeCode(new TypeError("x", { cause: "ECONNRESET" }))).toBe("");
    expect(causeCode(new TypeError("x", { cause: { code: "connect to https://secret" } }))).toBe(
      "",
    );
    expect(causeCode(new TypeError("x", { cause: { code: 54 } }))).toBe("");
    expect(causeCode("boom")).toBe("");
  });
});
