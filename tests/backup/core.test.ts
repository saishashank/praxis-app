// @vitest-environment node
// PLT-022, PLT-022b, DAT-143, DAT-142, TST-108: dump / restore / encrypt round trips and the
// retention selection (14 daily / 8 weekly / 12 monthly).
import { createClient, type Client } from "@libsql/client";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpDatabase, encodeValue, FOREVER_TABLES } from "@/lib/backup/dump";
import { decodeValue, parseBackup, restoreDatabase } from "@/lib/backup/restore";
import {
  decryptBytes,
  decryptToText,
  encryptBytes,
  exportEncrypted,
  looksLikeAge,
  parseRecipient,
} from "@/lib/backup/crypto";
import {
  assetName,
  backupTag,
  isValidDate,
  selectDeletions,
  selectRetained,
} from "@/lib/backup/retention";
import { cleanupTempDbs, freshDb, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const AT = "2026-10-11T00:00:00.000Z";
const MARK = "ROW-TEXT-MARKER-77c1";
const BLOB = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
const emptyDb = () => track(createClient({ url: tempDbUrl() }));

let main: Client;
let auth: Client;
beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  await main.execute({
    sql: "INSERT INTO app_log (at, level, source, message) VALUES (?, 'info', 's', ?)",
    args: [AT, `${MARK} Zoë 日本語 \u{1F642} "q" \\ \n tab\t`],
  });
  await main.execute({
    sql: "INSERT INTO run_record (job, concurrency_key, started_at, status, error_summary) VALUES ('j', 'k', ?, 'success', NULL)",
    args: [AT],
  });
  await main.execute({
    sql: "INSERT INTO config_version (key, value_json, changed_at) VALUES ('a', '1', ?)",
    args: [AT],
  });
  await main.execute({
    sql: "INSERT INTO request_nonce (nonce, expires_at) VALUES ('n1', 99)",
    args: [],
  });
  await auth.execute({
    sql: "INSERT INTO app_user (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: [`${MARK}@example.test`, null, AT, AT],
  });
  await auth.execute({
    sql: "INSERT INTO audit_event (at, action, prev_hmac, row_hmac) VALUES (?, 'x', ?, ?)",
    args: [AT, "0".repeat(64), "1".repeat(64)],
  });
  await auth.execute({
    sql: "INSERT INTO rate_limit SELECT 'k', 1, 1 WHERE 0",
    args: [],
  });
});

async function addMisc(db: Client) {
  await db.execute(
    "CREATE TABLE misc (id INTEGER PRIMARY KEY, t TEXT, n INTEGER, r REAL, b BLOB, z)",
  );
  await db.execute({
    sql: "INSERT INTO misc (t, n, r, b, z) VALUES (?, ?, ?, ?, ?)",
    args: ["héllo 🙂", -5, 2.5, BLOB, null],
  });
  await db.execute({
    sql: "INSERT INTO misc (t, n, r, b, z) VALUES (?, ?, ?, ?, ?)",
    args: [null, 0, null, new Uint8Array(0), "x"],
  });
}

describe("value encoding", () => {
  it("round-trips null, text, numbers, bigint, blobs and non-finite numbers", () => {
    expect(encodeValue(null)).toBeNull();
    expect(encodeValue(undefined)).toBeNull();
    expect(encodeValue("a")).toBe("a");
    expect(encodeValue(1.5)).toBe(1.5);
    expect(encodeValue(10n ** 20n)).toEqual({ $int: "100000000000000000000" });
    expect(decodeValue({ $int: "-12" })).toBe(-12n);
    expect(encodeValue(Number.POSITIVE_INFINITY)).toEqual({ $f: "Infinity" });
    expect(decodeValue({ $f: "-Infinity" })).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeValue({ $f: "NaN" })).toBeNaN();
    const enc = encodeValue(BLOB.buffer) as { $b64: string };
    expect(enc).toEqual({ $b64: Buffer.from(BLOB).toString("base64") });
    expect(new Uint8Array(decodeValue(enc) as ArrayBuffer)).toEqual(BLOB);
    expect(encodeValue(BLOB)).toEqual(enc); // typed arrays too
    expect(decodeValue("s")).toBe("s");
    expect(decodeValue(3)).toBe(3);
    expect(decodeValue(null)).toBeNull();
  });

  it("refuses unsupported or malformed values", () => {
    expect(() => encodeValue(true)).toThrow();
    for (const bad of [{ $int: "1.5" }, { $f: "x" }, { $b64: 1 }, { a: 1, b: 2 }, [1], {}, true]) {
      expect(() => decodeValue(bad)).toThrow();
    }
  });
});

describe("dumpDatabase", () => {
  it("writes meta, schema for every table, rows only for data tables, and an end line", async () => {
    const d = await dumpDatabase(main, { name: "main", createdAt: AT });
    const lines = d.text
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      kind: "meta",
      format: 1,
      db: "main",
      schema_version: 4,
      created_at: AT,
      ephemeral: ["request_nonce"],
    });
    expect(lines[0].tables).toEqual(
      expect.arrayContaining(["app_log", "config_version", "run_record", "schema_migrations"]),
    );
    expect(lines[0].tables).not.toContain("request_nonce");
    expect(lines[lines.length - 1].kind).toBe("end");
    const sch = lines.filter((l) => l.kind === "schema");
    expect(sch.some((l) => l.table === "request_nonce" && l.ephemeral === true)).toBe(true);
    expect(sch.some((l) => l.type === "trigger")).toBe(true);
    expect(sch.some((l) => l.type === "index")).toBe(true);
    expect(lines.some((l) => l.kind === "row" && l.table === "request_nonce")).toBe(false);
    expect(d.counts.app_log).toBe(1);
    expect(d.text.endsWith("\n")).toBe(true);
  });

  it("the auth DB leaves out rate_limit rows but keeps its schema; forever tables are labelled", async () => {
    await auth.execute("INSERT INTO rate_limit SELECT 'k', 1, 1");
    const d = await dumpDatabase(auth, { name: "auth", createdAt: AT });
    expect(d.meta.ephemeral).toEqual(["rate_limit"]);
    expect(d.meta.tables).not.toContain("rate_limit");
    expect(d.meta.forever).toEqual(["audit_event"]);
    expect(FOREVER_TABLES).toContain("audit_event");
    expect(d.text).not.toContain('"table":"rate_limit","values"');
  });

  it("is deterministic: the same data gives the same checksums", async () => {
    const a = await dumpDatabase(main, { name: "main", createdAt: AT });
    const b = await dumpDatabase(main, { name: "main", createdAt: AT });
    expect(a.text).toBe(b.text);
    expect(a.sha256).toEqual(b.sha256);
  });

  it("handles WITHOUT ROWID tables, and a database with no schema_migrations table", async () => {
    const db = emptyDb();
    await db.execute("CREATE TABLE w (a TEXT, b INTEGER, PRIMARY KEY (b, a)) WITHOUT ROWID");
    await db.execute("INSERT INTO w VALUES ('x', 2), ('y', 1)");
    const d = await dumpDatabase(db, { name: "main", createdAt: AT });
    expect(d.meta.schema_version).toBe(0);
    const rows = d.text.split("\n").filter((l) => l.includes('"table":"w","values"'));
    expect(rows.map((r) => JSON.parse(r).values)).toEqual([
      ["y", 1],
      ["x", 2],
    ]);
  });
});

describe("restoreDatabase", () => {
  it("round-trips the main DB: same rows, triggers and indexes, ephemeral table recreated empty", async () => {
    await addMisc(main);
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    const target = emptyDb();
    const r = await restoreDatabase(target, src.text);
    expect(r.counts).toEqual(src.counts);
    expect(r.sha256).toEqual(src.sha256);
    const log = await target.execute("SELECT message FROM app_log");
    expect(String(log.rows[0].message)).toContain("Zoë 日本語 \u{1F642}");
    const misc = await target.execute("SELECT t, n, r, b, z FROM misc ORDER BY id");
    expect(misc.rows[0].t).toBe("héllo 🙂");
    expect(new Uint8Array(misc.rows[0].b as ArrayBuffer)).toEqual(BLOB);
    expect(misc.rows[0].z).toBeNull();
    expect(misc.rows[1].t).toBeNull();
    expect((misc.rows[1].b as ArrayBuffer).byteLength).toBe(0);
    // The nonce table exists (schema kept) but holds no rows.
    expect(Number((await target.execute("SELECT COUNT(*) c FROM request_nonce")).rows[0].c)).toBe(
      0,
    );
    // Append-only trigger and index came back.
    await expect(target.execute("DELETE FROM config_version")).rejects.toThrow();
    const idx = await target.execute(
      "SELECT 1 FROM sqlite_master WHERE name = 'idx_run_record_started'",
    );
    expect(idx.rows.length).toBe(1);
    // And the migration table says the same version, so later migrations continue from it.
    const v = await target.execute("SELECT MAX(version) v FROM schema_migrations");
    expect(Number(v.rows[0].v)).toBe(4);
  });

  it("round-trips the auth DB (NULL name, unique indexes, audit trigger)", async () => {
    const src = await dumpDatabase(auth, { name: "auth", createdAt: AT });
    const target = emptyDb();
    const r = await restoreDatabase(target, src.text);
    expect(r.sha256).toEqual(src.sha256);
    expect(r.counts.app_user).toBe(1);
    await expect(target.execute("DELETE FROM audit_event")).rejects.toThrow();
  });

  it("refuses a stream whose rows were changed (checksum mismatch) and writes nothing", async () => {
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    const tampered = src.text.replace(MARK, "ROW-TEXT-MARKER-xxxx");
    expect(tampered).not.toBe(src.text);
    const target = emptyDb();
    await expect(restoreDatabase(target, tampered)).rejects.toThrow(/checksum mismatch/);
    const n = await target.execute("SELECT COUNT(*) c FROM sqlite_master");
    expect(Number(n.rows[0].c)).toBe(0);
  });

  it("refuses a dropped row (count mismatch), a truncated stream, and a missing end line", async () => {
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    const lines = src.text.trimEnd().split("\n");
    const rowAt = lines.findIndex((l) => l.includes('"table":"app_log","values"'));
    const dropped = lines.filter((_, i) => i !== rowAt).join("\n") + "\n";
    await expect(restoreDatabase(emptyDb(), dropped)).rejects.toThrow(/row count mismatch/);
    await expect(restoreDatabase(emptyDb(), src.text.slice(0, -1))).rejects.toThrow(/truncated/);
    const noEnd = lines.slice(0, -1).join("\n") + "\n";
    await expect(restoreDatabase(emptyDb(), noEnd)).rejects.toThrow(/no end line/);
    await expect(restoreDatabase(emptyDb(), "\n")).rejects.toThrow(/not JSON/);
  });

  it("refuses a forged end line that disagrees with the rows", async () => {
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    const lines = src.text.trimEnd().split("\n");
    const end = JSON.parse(lines[lines.length - 1]);
    end.sha256.app_log = "f".repeat(64);
    lines[lines.length - 1] = JSON.stringify(end);
    await expect(restoreDatabase(emptyDb(), lines.join("\n") + "\n")).rejects.toThrow(
      /checksum mismatch/,
    );
    end.sha256.app_log = "nothex";
    lines[lines.length - 1] = JSON.stringify(end);
    await expect(restoreDatabase(emptyDb(), lines.join("\n") + "\n")).rejects.toThrow(
      /bad checksum/,
    );
  });

  it("refuses structurally wrong streams", () => {
    const base = [
      '{"kind":"meta","format":1,"db":"main","schema_version":1,"created_at":"x","tables":[],"ephemeral":[],"forever":[]}',
      '{"kind":"end","counts":{},"sha256":{}}',
    ];
    const ok = (extra: string[] = []) => [base[0], ...extra, base[1]].join("\n") + "\n";
    expect(() => parseBackup(ok())).not.toThrow();
    const bad = (s: string, re: RegExp) => expect(() => parseBackup(s)).toThrow(re);
    bad("[1]\n{}\n", /no kind/);
    bad('{"kind":"x"}\n{"kind":"end","counts":{},"sha256":{}}\n', /first line/);
    bad(ok().replace('"format":1', '"format":2'), /first line/);
    bad(ok().replace('"db":"main"', '"db":"other"'), /unknown database/);
    bad(ok().replace('"tables":[],', ""), /bad meta/);
    bad(ok().replace('"counts":{}', '"counts":1'), /bad end/);
    bad(ok(['{"kind":"weird"}']), /unexpected line kind/);
    bad(ok(['{"kind":"row","table":"t","values":[1]}']), /undeclared table/);
    bad(ok(['{"kind":"schema","type":"table","table":"t"}']), /bad schema line/);
    bad(ok(['{"kind":"schema","type":"bogus","table":"t","sql":"x"}']), /bad schema type/);
    bad(ok(['{"kind":"schema","type":"index","table":"t","sql":"x"}']), /bad schema line/);
    const t = '{"kind":"schema","type":"table","table":"t","sql":"CREATE TABLE t (a)"}';
    bad(ok([t, t]), /duplicate table/);
    bad(ok([t]), /table list differs/);
    bad(ok([t.replace("}", ',"ephemeral":true}')]), /ephemeral flag/);
    bad(ok([t]).replace('"tables":[]', '"tables":["t"]'), /row count mismatch/);
    bad(ok().replace('"counts":{}', '"counts":{"zz":1}'), /unknown tables/);
  });

  it("refuses a non-empty target database", async () => {
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    await expect(restoreDatabase(main, src.text)).rejects.toThrow(/not empty/);
  });

  it("a schema that does not fit its rows fails and commits nothing (atomic batch)", async () => {
    const src = await dumpDatabase(main, { name: "main", createdAt: AT });
    const lines = src.text.trimEnd().split("\n");
    const i = lines.findIndex((l) => l.includes('"type":"table","table":"app_log"'));
    const s = JSON.parse(lines[i]);
    s.sql = s.sql.replace("CREATE TABLE app_log (", "CREATE TABLE app_log (zzz DEFAULT 1, ");
    lines[i] = JSON.stringify(s); // extra column: INSERT with the original arity fails
    const target = emptyDb();
    await expect(restoreDatabase(target, lines.join("\n") + "\n")).rejects.toThrow();
    const n = await target.execute("SELECT COUNT(*) c FROM sqlite_master");
    expect(Number(n.rows[0].c)).toBe(0);
  });
});

describe("encryption (age)", () => {
  it("round-trips with a generated identity; ciphertext is not plaintext and leaks no row text", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const exp = await exportEncrypted(main, { name: "main", createdAt: AT, recipient });
    expect(looksLikeAge(exp.data)).toBe(true);
    const bytes = Buffer.from(exp.data);
    expect(bytes.includes(MARK)).toBe(false);
    expect(bytes.includes("app_log")).toBe(false);
    const text = await decryptToText(exp.data, identity);
    expect(text).toContain(MARK); // plaintext only exists after decryption with the private key
    const target = emptyDb();
    const r = await restoreDatabase(target, text);
    expect(r.sha256).toEqual(exp.sha256);
    expect(exp.tables).toContain("app_log");
    expect(exp.schemaVersion).toBe(4);
  });

  it("another key cannot decrypt; tampered ciphertext is refused", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const enc = await encryptBytes(
      new TextEncoder().encode("hello"),
      await identityToRecipient(id1),
    );
    await expect(decryptBytes(enc, id2)).rejects.toThrow();
    const bad = Uint8Array.from(enc);
    bad[bad.length - 5] ^= 1;
    await expect(decryptBytes(bad, id1)).rejects.toThrow();
    expect(new TextDecoder().decode(await decryptBytes(enc, id1))).toBe("hello");
  });

  it("parseRecipient accepts only a valid native age recipient", async () => {
    const r = await identityToRecipient(await generateIdentity());
    expect(parseRecipient(r)).toBe(r);
    expect(parseRecipient(`  ${r}\n`)).toBe(r);
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "   ",
      "age1",
      "age1" + "q".repeat(58), // right shape, wrong bech32 checksum
      r.slice(0, -1),
      `${r}${r}`,
      `${r}\n${r}`,
      await generateIdentity(), // a private key must never be accepted as the public key
      "ssh-ed25519 AAAA",
    ]) {
      expect(parseRecipient(bad)).toBeNull();
    }
    await expect(encryptBytes(new Uint8Array(1), "nope")).rejects.toThrow(
      /invalid backup public key/,
    );
  });

  it("looksLikeAge refuses plaintext and short input", () => {
    expect(looksLikeAge(new TextEncoder().encode('{"kind":"meta"}'))).toBe(false);
    expect(looksLikeAge(new Uint8Array(3))).toBe(false);
  });
});

describe("selectRetained (14 daily / 8 weekly / 12 monthly)", () => {
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const range = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

  it("keeps today and the 13 days before; day 13 vs day 14 boundary", () => {
    const today = "2026-10-11"; // a Sunday
    const dates = range(addDays(today, -40), 41);
    const keep = selectRetained(dates, today);
    expect(keep).toContain(addDays(today, -13));
    expect(keep).toContain(today);
    // day 14 is outside the daily window; it survives only if it is a week/month newest
    const day14 = addDays(today, -14); // Sunday 27 Sep: newest of its ISO week
    expect(keep).toContain(day14);
    const day15 = addDays(today, -15); // Saturday: not newest of its week (Sunday 27 Sep exists)
    expect(keep).not.toContain(day15);
    const day16 = addDays(today, -16);
    expect(keep).not.toContain(day16);
  });

  it("with only daily-spaced data the day-14 backup is dropped when it is not a week/month newest", () => {
    const today = "2026-10-14"; // Wednesday
    const dates = range("2026-09-01", 44); // 1 Sep .. 14 Oct
    const keep = selectRetained(dates, today);
    expect(keep).toContain("2026-10-01"); // day 13
    expect(keep).not.toContain("2026-09-29"); // day 15: not newest of its week or month
    expect(keep).toContain("2026-09-30"); // day 14, kept only as the newest backup of September
    expect(keep).toContain("2026-10-04"); // newest of the ISO week of 28 Sep .. 4 Oct
  });

  it("keeps the newest backup of each of the last 8 ISO weeks and not the 9th", () => {
    const today = "2026-10-14"; // week starting Mon 12 Oct
    const dates = range("2026-06-01", 136);
    const keep = selectRetained(dates, today);
    // week index 7 back starts Mon 24 Aug; newest of that week is Sun 30 Aug
    expect(keep).toContain("2026-08-30");
    // week index 8 back (starts Mon 17 Aug): its newest is Sun 23 Aug -> not a weekly keeper
    expect(keep).not.toContain("2026-08-23");
    // ...but monthly keepers still hold the newest of each month
    expect(keep).toContain("2026-08-31");
  });

  it("ISO week rollover: Mon 29 Dec 2025 .. Sun 4 Jan 2026 is ONE week across the year boundary", () => {
    const today = "2026-02-20"; // Friday; its week starts Mon 16 Feb, so 29 Dec's week is 7 weeks back
    const dates = ["2025-12-29", "2025-12-30", "2026-01-02", "2026-01-04", "2026-01-31"];
    const keep = selectRetained(dates, today);
    expect(keep).toContain("2026-01-04"); // newest of the boundary week (the 8th week back)
    expect(keep).not.toContain("2026-01-02");
    expect(keep).not.toContain("2025-12-29"); // same week as 4 Jan, and not December's newest
    expect(keep).toContain("2025-12-30"); // kept only as the newest backup of December
  });

  it("month rollover and year rollover: newest of each of the last 12 months, the 13th dropped", () => {
    const today = "2026-10-15";
    const months: string[] = [];
    // two backups in each month from Aug 2025 to Oct 2026
    for (let y = 2025, m = 8; y < 2026 || m <= 10; m++) {
      if (m > 12) {
        m = 1;
        y += 1;
      }
      months.push(`${y}-${String(m).padStart(2, "0")}-05`, `${y}-${String(m).padStart(2, "0")}-20`);
      if (y === 2026 && m === 10) break;
    }
    const keep = selectRetained(months, today);
    // 12 months back from Oct 2026 = Nov 2025 .. Oct 2026
    expect(keep).toContain("2025-11-20");
    expect(keep).toContain("2025-12-20");
    expect(keep).toContain("2026-01-20");
    expect(keep).not.toContain("2025-11-05");
    // Oct 2025 is the 13th month back: dropped
    expect(keep).not.toContain("2025-10-20");
    expect(keep).not.toContain("2025-08-20");
  });

  it("keeps dates after today, ignores invalid dates, de-duplicates, returns ascending", () => {
    const keep = selectRetained(
      ["2030-01-01", "2026-10-11", "bad", "2026-13-45", "2026-10-11"],
      "2026-10-11",
    );
    expect(keep).toEqual(["2026-10-11", "2030-01-01"]);
    expect(selectRetained([], "2026-10-11")).toEqual([]);
    expect(() => selectRetained([], "nope")).toThrow();
  });

  it("selectDeletions is exactly the complement of selectRetained", () => {
    const today = "2026-10-11";
    const dates = range(addDays(today, -400), 401);
    const keep = new Set(selectRetained(dates, today));
    const del = selectDeletions(dates, today);
    expect(del.length + keep.size).toBe(dates.length);
    for (const d of del) expect(keep.has(d)).toBe(false);
    // steady state size: 14 daily + at most 8 weekly + 12 monthly (overlaps shrink it)
    expect(keep.size).toBeLessThanOrEqual(14 + 8 + 12);
    expect(keep.size).toBeGreaterThanOrEqual(14 + 7);
  });

  it("helpers", () => {
    expect(backupTag("2026-10-11")).toBe("backup-2026-10-11");
    expect(assetName("main", "2026-10-11")).toBe("main-2026-10-11.ndjson.gz.age");
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate(5)).toBe(false);
  });
});
