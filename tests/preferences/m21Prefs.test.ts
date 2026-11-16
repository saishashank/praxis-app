// @vitest-environment node
// M21 A1 (D-1217, D-1218, D-1226): the three new preference fields. stop_hit_emails (on/off, stored only once chosen, so
// its effective default is the config key), real_capital (whole home-currency units, Owner only) and broker_links (up to
// five templates the Owner types, Owner only). Structured fields have their own validators.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validBrokerTemplate, fillBrokerTemplate } from "@/lib/preferences/brokerTemplate";
import {
  DEFAULT_PREFERENCES,
  effectiveStopHitEmails,
  getPreferences,
  updatePreferences,
} from "@/lib/preferences/service";
import { loadSettings } from "@/lib/ui/loaders/settings";
import { isPinnedOwnerId, ownerTools } from "@/lib/preferences/ownerTools";
import { setConfig } from "@/lib/config/store";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser, auditRows, authDb, ENV, NOW } from "../auth/helpers";

afterEach(cleanupTempDbs);

let db: Client;
let owner: number;
let editor: number;
let viewer: number;
const META = { ip: "1.1.1.1", userAgent: "ua" };
const upd = async (patch: unknown, id = owner) =>
  updatePreferences(
    db,
    ENV,
    META,
    { id, pinnedOwner: await isPinnedOwnerId(db, id, ENV) },
    patch,
    NOW,
  );
const raw = async (id: number) =>
  JSON.parse(
    String(
      (
        await db.execute({
          sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
          args: [id],
        })
      ).rows[0]?.prefs_json ?? "{}",
    ),
  );

beforeEach(async () => {
  db = await authDb();
  owner = await addUser(db, { email: "owner@example.test", role: "owner" });
  editor = await addUser(db, { email: "e@example.test", role: "editor" });
  viewer = await addUser(db, { email: "v@example.test", role: "viewer" });
});

const T = "https://broker.example.com/quote/{code}";
const LINKS = [
  { name: "Broker one", url_template: T },
  { name: "Broker two", url_template: "https://www.example.org/q?symbol={code}&mkt={market}" },
];

describe("defaults", () => {
  it("a fresh user has stop_hit_emails off, no capital and no links", async () => {
    expect(await getPreferences(db, owner)).toMatchObject({
      stop_hit_emails: "off",
      real_capital: 0,
      broker_links: [],
    });
    expect(DEFAULT_PREFERENCES.real_capital).toBe(0);
    expect(DEFAULT_PREFERENCES.broker_links).toEqual([]);
  });

  it("an unrelated save stores none of the three fields", async () => {
    await upd({ theme: "dim" });
    const r = await raw(owner);
    for (const f of ["stop_hit_emails", "real_capital", "broker_links"])
      expect(r).not.toHaveProperty(f);
  });
});

describe("stop_hit_emails (EML-043, D-1226)", () => {
  it("round-trips for every role; an unknown value is invalid", async () => {
    for (const id of [owner, editor, viewer]) {
      expect(await upd({ stop_hit_emails: "on" }, id)).toEqual({
        ok: true,
        changed: ["stop_hit_emails"],
      });
      expect((await getPreferences(db, id)).stop_hit_emails).toBe("on");
    }
    expect(await upd({ stop_hit_emails: "yes" })).toEqual({ ok: false, error: "invalid" });
  });

  it("choosing off is stored (an explicit choice), and the effective default follows the config key until then", async () => {
    expect(effectiveStopHitEmails(null, "on")).toBe("on");
    expect(effectiveStopHitEmails(null, "off")).toBe("off");
    expect(effectiveStopHitEmails(null, undefined)).toBe("off");
    expect(effectiveStopHitEmails("off", "on")).toBe("off");
    expect(effectiveStopHitEmails("on", "off")).toBe("on");
    expect(await upd({ stop_hit_emails: "off" })).toEqual({
      ok: true,
      changed: ["stop_hit_emails"],
    });
    expect((await raw(owner)).stop_hit_emails).toBe("off");
  });
});

describe("real_capital (UXN-315, D-1217)", () => {
  it("round-trips whole units from 0 to 10,000,000, for the Owner", async () => {
    for (const v of [100_000, 10_000_000, 1, 0]) {
      expect(await upd({ real_capital: v })).toMatchObject({ ok: true });
      expect((await getPreferences(db, owner)).real_capital).toBe(v);
    }
    expect((await raw(owner)).real_capital).toBe(0); // clearing is stored as 0 = not set
  });

  it("refuses fractions, negatives, text, huge values and NaN", async () => {
    for (const bad of [
      1.5,
      -1,
      "5000",
      10_000_001,
      Number.NaN,
      null,
      Number.POSITIVE_INFINITY,
      [5],
    ]) {
      expect(await upd({ real_capital: bad }), String(bad)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect((await getPreferences(db, owner)).real_capital).toBe(0);
  });

  it("an Editor or Viewer write is forbidden and changes nothing, even beside a valid field", async () => {
    for (const id of [editor, viewer]) {
      expect(await upd({ real_capital: 5000 }, id)).toEqual({ ok: false, error: "forbidden" });
      expect(await upd({ theme: "dim", real_capital: 5000 }, id)).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect((await getPreferences(db, id)).real_capital).toBe(0);
      expect((await getPreferences(db, id)).theme).toBe("light");
    }
  });

  it("the read is role-blind: the writers and the Owner-tool loaders are what check the role", async () => {
    await db.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)",
      args: [editor, JSON.stringify({ real_capital: 5000, broker_links: LINKS }), "x"],
    });
    // the read is role-blind (it has no role); the writers and the Owner-tool loaders are what check the role
    expect((await getPreferences(db, editor)).real_capital).toBe(5000);
  });

  it("the audit event names the field and never the amount", async () => {
    await upd({ real_capital: 123_456 });
    const rows = await auditRows(db);
    const a = rows.filter((r) => r.action === "user.preferences_update").at(-1)!;
    expect(a.detail).toEqual({ changed: ["real_capital"] });
    expect(JSON.stringify(rows)).not.toContain("123456");
  });
});

describe("broker_links (UXN-317, D-1218)", () => {
  it("round-trips up to five templates, for the Owner", async () => {
    expect(await upd({ broker_links: LINKS })).toEqual({ ok: true, changed: ["broker_links"] });
    expect((await getPreferences(db, owner)).broker_links).toEqual(LINKS);
    const five = Array.from({ length: 5 }, (_, i) => ({
      name: `Broker ${i + 1}`,
      url_template: `https://b${i + 1}.example.com/{code}`,
    }));
    expect(await upd({ broker_links: five })).toMatchObject({ ok: true });
    expect(await upd({ broker_links: [] })).toMatchObject({ ok: true });
    expect((await getPreferences(db, owner)).broker_links).toEqual([]);
  });

  it("refuses six templates, a bad shape, a bad name, an extra property and a bad template", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      name: `B${i}`,
      url_template: `https://b${i}.example.com/{code}`,
    }));
    for (const bad of [
      six,
      "https://x.example.com/{code}",
      [null],
      [{ name: "", url_template: T }],
      [{ name: "x".repeat(41), url_template: T }],
      [{ name: "Ok", url_template: T, extra: 1 }],
      [{ name: "Ok" }],
      [{ name: "Ok", url_template: 5 }],
      [{ name: "Ok", url_template: "http://broker.example.com/{code}" }],
      [{ name: "Ok\nline", url_template: T }],
    ]) {
      expect(await upd({ broker_links: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect((await getPreferences(db, owner)).broker_links).toEqual([]);
  });

  it("an Editor's write is forbidden", async () => {
    expect(await upd({ broker_links: LINKS }, editor)).toEqual({ ok: false, error: "forbidden" });
    expect(await upd({ broker_links: LINKS }, viewer)).toEqual({ ok: false, error: "forbidden" });
    expect((await getPreferences(db, editor)).broker_links).toEqual([]);
  });

  it("a stored list with a bad template reads as the valid templates only", async () => {
    await db.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)",
      args: [
        owner,
        JSON.stringify({
          broker_links: [
            LINKS[0],
            { name: "Bad", url_template: "http://x.example.com/{code}" },
            { nope: 1 },
          ],
        }),
        "x",
      ],
    });
    expect((await getPreferences(db, owner)).broker_links).toEqual([LINKS[0]]);
  });

  it("a later save keeps the stored structured fields", async () => {
    await upd({ real_capital: 5000, broker_links: LINKS });
    await upd({ theme: "dim" });
    const r = await raw(owner);
    expect(r.real_capital).toBe(5000);
    expect(r.broker_links).toEqual(LINKS);
  });
});

describe("validBrokerTemplate", () => {
  const ok = (t: string) => expect(validBrokerTemplate(t), t).toEqual({ ok: true });
  const bad = (t: string, why: RegExp) => {
    const r = validBrokerTemplate(t);
    expect(r.ok, t).toBe(false);
    if (!r.ok) expect(r.reason, t).toMatch(why);
  };

  it("accepts https templates with {code} (and optionally {market}) in the path or a query value", () => {
    ok("https://broker.example.com/quote/{code}");
    ok("https://broker.example.com/{market}/{code}");
    ok("https://www.example.org/q?symbol={code}&mkt={market}");
    ok("https://broker.example.com/quote/{code}/chart?range=1y");
  });

  it("refuses userinfo, http, a fragment, an unknown placeholder, a missing {code}, a placeholder in the host", () => {
    bad("https://user@broker.example.test/{code}", /user/i);
    bad("https://user:pass@broker.example.test/{code}", /user/i);
    bad("http://broker.example.com/{code}", /https/i);
    bad("ftp://broker.example.com/{code}", /https/i);
    bad("//broker.example.com/{code}", /https/i);
    bad("https://broker.example.com/{code}#top", /fragment/i);
    bad("https://broker.example.com/{code}/{price}", /placeholder/i);
    bad("https://broker.example.com/{CODE}", /placeholder/i);
    bad("https://broker.example.com/{code", /placeholder|brace/i);
    bad("https://broker.example.com/quote", /\{code\}/);
    bad("https://{code}.example.com/", /host|address/i);
    bad("https://broker.example.com{code}", /host|address|path/i);
  });

  it("refuses a credential-like query key, an address with no dot or an IP, control characters and a long text", () => {
    for (const k of [
      "key",
      "api_key",
      "apikey",
      "token",
      "access_token",
      "password",
      "secret",
      "auth",
      "session",
      "sig",
    ]) {
      bad(`https://broker.example.com/{code}?${k}=abc`, /credential|key/i);
    }
    bad("https://broker.example.com/{code}?Token=abc", /credential|key/i);
    bad("https://localhost/{code}", /host|address/i);
    bad("https://127.0.0.1/{code}", /host|address/i);
    bad("https://[::1]/{code}", /host|address/i);
    bad("https://broker.example.com/{code}\n", /character/i);
    bad("https://broker.example.com/" + "a".repeat(300) + "{code}", /long/i);
    bad("", /https/i);
  });

  it("fillBrokerTemplate substitutes the code and market and adds nothing else", () => {
    expect(fillBrokerTemplate("https://b.example.com/{market}/{code}?q={code}", "ZZ1", "AU")).toBe(
      "https://b.example.com/AU/ZZ1?q=ZZ1",
    );
    // a code is encoded, so it cannot break out of its slot
    expect(fillBrokerTemplate("https://b.example.com/{code}", "A/B?c#d", "AU")).toBe(
      "https://b.example.com/A%2FB%3Fc%23d",
    );
    expect(fillBrokerTemplate("http://b.example.com/{code}", "ZZ1", "AU")).toBeNull();
  });
});

describe("the pinned Owner, not the stored role (D-1214)", () => {
  // the one stored owner row, seen by an environment that pins another e-mail: a database-role owner who is not pinned
  const OTHER_PIN = { ...ENV, OWNER_EMAIL: "someone-else@example.test" };

  it("a database-role owner who is not the pinned e-mail is refused for real_capital and broker_links", async () => {
    expect(await isPinnedOwnerId(db, owner, OTHER_PIN)).toBe(false);
    const pinnedOwner = await isPinnedOwnerId(db, owner, OTHER_PIN);
    const asOther = (patch: unknown) =>
      updatePreferences(db, OTHER_PIN, META, { id: owner, pinnedOwner }, patch, NOW);
    expect(await asOther({ real_capital: 5000 })).toEqual({ ok: false, error: "forbidden" });
    expect(await asOther({ broker_links: LINKS })).toEqual({ ok: false, error: "forbidden" });
    // a caller that wrongly claims the pin for an Editor is stopped by the stored role
    expect(
      await updatePreferences(
        db,
        ENV,
        META,
        { id: editor, pinnedOwner: true },
        { real_capital: 1 },
        NOW,
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    // an ordinary field still works for that owner
    expect(await asOther({ theme: "dim" })).toMatchObject({ ok: true });
  });

  it("the pinned Owner is allowed; a caller that passes no pin is refused", async () => {
    expect(await isPinnedOwnerId(db, owner, ENV)).toBe(true);
    expect(await upd({ real_capital: 5000 })).toMatchObject({ ok: true });
    expect(
      await updatePreferences(db, ENV, META, { id: owner }, { real_capital: 6000 }, NOW),
    ).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("ownerTools: the one read (pin and switch)", () => {
  it("returns the values only to the pinned Owner while owner_real_money_tools is on", async () => {
    invalidateConfigCache();
    const main = await freshDb("main");
    await upd({ real_capital: 5000, broker_links: LINKS });
    const dbs = { auth: db, main };
    expect(await ownerTools(dbs, { id: owner }, ENV)).toBeNull(); // switch off (default)
    await setConfig(main, {
      key: "owner_real_money_tools",
      value: "on",
      userId: null,
      reason: "test",
      now: NOW.toISOString(),
    });
    expect(await ownerTools(dbs, { id: owner }, ENV)).toEqual({
      real_capital: 5000,
      broker_links: LINKS,
    });
    const notPinned = { ...ENV, OWNER_EMAIL: "someone-else@example.test" };
    expect(await ownerTools(dbs, { id: owner }, notPinned)).toBeNull(); // role owner, not the pinned e-mail
    expect(await ownerTools(dbs, { id: editor }, ENV)).toBeNull();
    expect(await ownerTools(dbs, null, ENV)).toBeNull();
  });
});

describe("loadSettings strips the Owner-tool fields unless the switch is on (D-1214)", () => {
  it("real_capital and broker_links are 0 and [] while off and present when on, for the pinned Owner only", async () => {
    invalidateConfigCache();
    const main = await freshDb("main");
    const prev = process.env.OWNER_EMAIL;
    process.env.OWNER_EMAIL = ENV.OWNER_EMAIL;
    try {
      await upd({ real_capital: 5000, broker_links: LINKS });
      const env = (id: number, role: string) =>
        ({ main, auth: db, user: { id, role } }) as unknown as Parameters<typeof loadSettings>[0];
      let m = await loadSettings(env(owner, "owner"));
      expect([m.preferences.real_capital, m.preferences.broker_links]).toEqual([0, []]);
      await setConfig(main, {
        key: "owner_real_money_tools",
        value: "on",
        userId: null,
        reason: "test",
        now: NOW.toISOString(),
      });
      invalidateConfigCache();
      m = await loadSettings(env(owner, "owner"));
      expect([m.preferences.real_capital, m.preferences.broker_links]).toEqual([5000, LINKS]);
      m = await loadSettings(env(editor, "editor"));
      expect([m.preferences.real_capital, m.preferences.broker_links]).toEqual([0, []]);
    } finally {
      if (prev === undefined) delete process.env.OWNER_EMAIL;
      else process.env.OWNER_EMAIL = prev;
    }
  });
});
