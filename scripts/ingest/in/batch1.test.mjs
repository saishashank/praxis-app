// M20 IN1 (D-1127, D-1093, D-1125): the India batch-1 CLI. No network: the polite client is injected. With India off the
// CLI refuses before any request or file read; a refused or failed source is an absent file with a word, never an error.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { FILE_NAMES, fetchDay, firstZipEntry, requestOf, run } from "./batch1.mjs";
import { PoliteFetchRefused } from "../../../src/lib/data/sources/politeFetch.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "in1-"));

/** A one-file zip (central directory present), stored or deflated. */
function zip(name, text, deflate) {
  const raw = Buffer.from(text);
  const data = deflate ? deflateRawSync(raw) : raw;
  const nm = Buffer.from(name);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(deflate ? 8 : 0, 8);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nm.length, 26);
  const local = Buffer.concat([lh, nm, data]);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(deflate ? 8 : 0, 10);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(nm.length, 28);
  ch.writeUInt32LE(0, 42);
  const central = Buffer.concat([ch, nm]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test("the first zip entry is read, stored or deflated", () => {
  assert.equal(firstZipEntry(zip("a.csv", "x,y\n1,2\n", false)), "x,y\n1,2\n");
  assert.equal(firstZipEntry(zip("a.csv", "x,y\n1,2\n".repeat(50), true)), "x,y\n1,2\n".repeat(50));
  assert.equal(firstZipEntry(Buffer.from("not a zip at all")), null);
});

test("each key has the archive URL of its register source, and none for a hand-supplied file", () => {
  assert.match(
    requestOf("bhavcopy", "2026-11-12").url,
    /BhavCopy_NSE_CM_0_0_0_20261112_F_0000\.csv\.zip$/,
  );
  assert.equal(requestOf("bhavcopy", "2026-11-12").source, "in_nse_bhavcopy");
  assert.match(requestOf("bands", "2026-11-12").url, /sec_list_12112026\.csv$/);
  assert.equal(requestOf("index", "2026-11-12"), null);
  assert.ok(Object.keys(FILE_NAMES).length >= 11);
});

test("fetchDay: ok, http error, refusal by the gate and a network failure are words, never throws", async () => {
  const csv = "Symbol,Series,Security Name,Band,Remarks\nAAA,EQ,A,5,-\n";
  const client = {
    fetch: async (url, init) => {
      if (init.source === "in_nse_bhavcopy")
        return new Response(zip("b.csv", "h\n1\n", true), { status: 200 });
      if (init.source === "in_nse_bands") return new Response(csv, { status: 200 });
      if (init.source === "in_nse_asm_gsm" && url.endsWith("reportASM"))
        return new Response("", { status: 403 });
      if (init.source === "in_nse_asm_gsm") throw new PoliteFetchRefused("robots_disallowed");
      throw new Error("boom");
    },
  };
  const r = await fetchDay(client, "2026-11-12", [
    "bhavcopy",
    "bands",
    "asm",
    "gsm",
    "classification",
    "index",
  ]);
  assert.deepEqual(Object.keys(r.files).sort(), ["bands", "bhavcopy"]);
  assert.deepEqual(r.status, {
    bhavcopy: "ok",
    bands: "ok",
    asm: "http_403",
    gsm: "refused_robots_disallowed",
    classification: "network",
    index: "no_public_source",
  });
});

async function dbWith(inEnabled) {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    "CREATE TABLE market (code TEXT PRIMARY KEY, enabled INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'off')",
  );
  await db.execute("CREATE TABLE source_register (source TEXT PRIMARY KEY, status TEXT NOT NULL)");
  await db.execute("INSERT INTO market VALUES ('AU', 1, 'full')");
  await db.execute({
    sql: "INSERT INTO market VALUES ('IN', ?, 'data_only')",
    args: [inEnabled ? 1 : 0],
  });
  await db.execute(
    "INSERT INTO source_register VALUES ('in_nse_bhavcopy', 'enabled'), ('in_nse_bands', 'pending')",
  );
  return db;
}

test("India off: both commands refuse with the standard line before any request", async () => {
  const lines = [];
  const off = await dbWith(false);
  const client = { fetch: () => assert.fail("no request when the market is off") };
  const code = await run(
    ["fetch", "--market", "IN", "--d", "2026-11-12", "--dir", tmp()],
    { TURSO_MAIN_URL: "file:x" },
    { openDb: () => off, out: (s) => lines.push(s), client },
  );
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /market not enabled/);
  const code2 = await run(
    ["run", "--market", "IN", "--d", "2026-11-12", "--dir", tmp()],
    { TURSO_MAIN_URL: "file:x" },
    { openDb: () => off, out: (s) => lines.push(s), client },
  );
  assert.equal(code2, 2);
});

test("India on: fetch asks only the enabled sources and writes the files it got", async () => {
  const dir = tmp();
  const asked = [];
  const client = {
    fetch: async (url, init) => {
      asked.push(init.source);
      return new Response(zip("b.csv", "TradDt\n2026-11-12\n", false), { status: 200 });
    },
  };
  const lines = [];
  const db = await dbWith(true);
  const ok = await run(
    ["fetch", "--market", "IN", "--d", "2026-11-12", "--dir", dir],
    { TURSO_MAIN_URL: "file:x" },
    { openDb: () => db, out: (s) => lines.push(s), client },
  );
  assert.equal(ok, 0);
  assert.deepEqual(asked, ["in_nse_bhavcopy"]); // the pending bands source is not requested
  assert.ok(fs.existsSync(path.join(dir, FILE_NAMES.bhavcopy)));
});

test("usage and configuration errors", async () => {
  const out = [];
  assert.equal(await run(["fetch"], {}, { out: (s) => out.push(s) }), 1);
  assert.equal(
    await run(["fetch", "--d", "2026-11-12", "--dir", tmp()], {}, { out: (s) => out.push(s) }),
    1,
  );
  assert.match(out.join("\n"), /database not configured|usage/);
});
