// @vitest-environment node
// M22 L5 (LLM-079, D-1414…D-1416): the CLI entry with a fake embedder and a throwaway database: off writes nothing, on writes
// bounded rows and prints counts only, a missing model fails closed with exit 0, `embed` writes vectors and labels but no text.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { minilmMain } from "@/lib/llm/minilm/cli";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { fakeEmbedder, headOf, lockOf, SHA_A } from "./helpers";

afterEach(cleanupTempDbs);
const dir = mkdtempSync(path.join(tmpdir(), "minilm-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const D = "2030-01-02";
const setKey = (db: Client, key: string, json: string) =>
  db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES (?, 'global', ?, NULL, NULL, '2030-01-01T00:00:00.000Z', 'test')`,
    args: [key, json],
  });

async function world(on: boolean, cap = 3): Promise<Client> {
  const db = await freshDb("main");
  if (on) await setKey(db, "minilm_enabled", '"on"');
  await setKey(db, "news_assess_per_run", String(cap));
  for (let i = 0; i < 5; i++)
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, title, source)
            VALUES ('AU', 'ZZAA', ?, ?, ?, NULL, ?, 'zz')`,
      args: [
        `a${i}`,
        `${D}T0${i}:00:00.000Z`,
        `${D}T12:00:00.000Z`,
        i === 0 ? "Trading Halt" : `Item ${i}`,
      ],
    });
  return db;
}
const count = async (db: Client) =>
  Number((await db.execute("SELECT COUNT(*) n FROM minilm_shadow")).rows[0]!.n);
const env = { TURSO_MAIN_URL: "file:zz" };
const deps = (db: Client, lines: string[], over: object = {}) => ({
  openDb: () => db,
  out: (s: string) => lines.push(s),
  head: headOf(),
  lock: lockOf(),
  loadEmbedder: () => Promise.resolve(fakeEmbedder()),
  ...over,
});
const ARGS = ["--date", D, "--model", "m.onnx", "--vocab", "v.txt"];

describe("minilmMain shadow", () => {
  it("off: nothing written, nothing loaded, exit 0", async () => {
    const db = await world(false);
    const lines: string[] = [];
    let loaded = false;
    const code = await minilmMain(
      ARGS,
      env,
      deps(db, lines, { loadEmbedder: () => ((loaded = true), Promise.resolve("x")) }),
    );
    expect(code).toBe(0);
    expect(loaded).toBe(false);
    expect(await count(db)).toBe(0);
    expect(lines).toEqual([`minilm-shadow AU ${D}: off written=0 rows=0 agree=0 material_agree=0`]);
  });

  it("on: writes at most news_assess_per_run rows and prints counts only", async () => {
    const db = await world(true, 3);
    const lines: string[] = [];
    expect(await minilmMain(ARGS, env, deps(db, lines))).toBe(0);
    expect(await count(db)).toBe(3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^minilm-shadow AU 2030-01-02: written written=3 rows=3 agree=\d material_agree=\d$/,
    );
    expect(lines[0]).not.toMatch(/Halt|Item/);
  });

  it("a model that cannot be loaded fails closed: exit 0, nothing written, the reason said", async () => {
    const db = await world(true);
    const lines: string[] = [];
    const code = await minilmMain(
      ARGS,
      env,
      deps(db, lines, {
        loadEmbedder: () => Promise.resolve("the model runtime is not available"),
      }),
    );
    expect(code).toBe(0);
    expect(await count(db)).toBe(0);
    expect(lines[0]).toContain("unavailable (the model runtime is not available)");
  });

  it("on but not trained: says so and writes nothing", async () => {
    const db = await world(true);
    const lines: string[] = [];
    await minilmMain(ARGS, env, deps(db, lines, { head: headOf({ trained: false }) }));
    expect(lines[0]).toContain("not_ready (The local classifier has not been trained yet)");
    expect(await count(db)).toBe(0);
  });

  it("without a database, in a replay, and on a database fault it exits 0 and changes nothing", async () => {
    const lines: string[] = [];
    expect(await minilmMain([], {}, { out: (s) => lines.push(s) })).toBe(0);
    expect(lines[0]).toContain("degraded");
    expect(await minilmMain(["--replay"], env, { out: (s) => lines.push(s) })).toBe(0);
    expect(lines).toHaveLength(1);
    const broken = {
      execute: () => Promise.reject(new Error("x")),
      batch: () => Promise.reject(new Error("x")),
    } as unknown as Client;
    expect(await minilmMain(ARGS, env, deps(broken, lines))).toBe(0);
    expect(lines[1]).toContain("degraded");
  });
});

describe("minilmMain embed", () => {
  it("writes the header, the rule label and the vector, never the title", async () => {
    const inFile = path.join(dir, "in.jsonl");
    const outFile = path.join(dir, "out.jsonl");
    writeFileSync(
      inFile,
      `${JSON.stringify({ type: "Trading Halt", title: "Trading Halt" })}\n${JSON.stringify({ title: "Secret Wording", label: "results" })}\n`,
    );
    const lines: string[] = [];
    const code = await minilmMain(
      ["embed", "--in", inFile, "--out", outFile, "--model", "m", "--vocab", "v"],
      {},
      { out: (s) => lines.push(s), loadEmbedder: () => Promise.resolve(fakeEmbedder()) },
    );
    expect(code).toBe(0);
    const text = readFileSync(outFile, "utf8");
    expect(text).not.toMatch(/Secret|Halt/);
    const [h, a, b] = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(h).toEqual({ format: "praxis-minilm-emb/1", modelSha: SHA_A, dim: 4 });
    expect(a.label).toBe("halt_suspension");
    expect(b.label).toBe("results");
    expect(a.embedding).toHaveLength(4);
  });

  it("refuses without arguments or without a model", async () => {
    const lines: string[] = [];
    expect(await minilmMain(["embed"], {}, { out: (s) => lines.push(s) })).toBe(2);
    expect(
      await minilmMain(
        ["embed", "--in", "a", "--out", "b", "--model", "m", "--vocab", "v"],
        {},
        {
          out: (s) => lines.push(s),
          loadEmbedder: () => Promise.resolve("the model file cannot be read"),
        },
      ),
    ).toBe(2);
  });
});
