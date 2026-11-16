// @vitest-environment node
// M21 B1 (AT-78, UXN-317, D-1218): the app never asks for a credential. No password input, no input, form field or stored
// preference named like a password, token, PIN, account number, API key or secret anywhere in src/app and src/components,
// and a broker address template that carries one is refused. Source scan, no network.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "@/lib/preferences/service";
import { validBrokerTemplate } from "@/lib/preferences/brokerTemplate";

const ROOT = path.resolve(import.meta.dirname, "../..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(rel);
  }
  return out;
};
const files = [...walk("src/app"), ...walk("src/components")];

/** A name that stands for something secret. */
export const CREDENTIAL_NAME =
  /pass[-_ ]?(word|wd|code|phrase)|\bpwd\b|(^|[^a-z])token([^a-z]|$)|(^|[^a-z])pin([^a-z]|$)|account[-_ ]?(no|num|number)|api[-_ ]?key|secret|credential|cvv|card[-_ ]?number|bsb/i;

const FIELD_NAME = /<(?:input|textarea|select)\b[^>]*?\bname=["'`]([^"'`]+)["'`]/gs;
const PASSWORD_TYPE = /\btype=["'`]password["'`]|autoComplete=["'`](?:current|new)-password["'`]/i;

describe("no credential field", () => {
  it("the scan looks at the real source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/components/ownerTools/BrokerLinksForm.tsx");
  });

  it("no password input and no password autocomplete hint", () => {
    const bad = files.filter((f) =>
      PASSWORD_TYPE.test(fs.readFileSync(path.join(ROOT, f), "utf8")),
    );
    expect(bad).toEqual([]);
  });

  it("no input, textarea or select is named like a credential", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(FIELD_NAME)) {
        if (CREDENTIAL_NAME.test(m[1]!)) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no stored preference is named like a credential", () => {
    expect(Object.keys(DEFAULT_PREFERENCES).filter((k) => CREDENTIAL_NAME.test(k))).toEqual([]);
  });

  it("the Owner-tool forms name only the fields the design lists (B2 adds the trade log fields: market, side, date, price, fees, note, reason, trade_id)", () => {
    const names = new Set<string>();
    for (const f of files.filter((x) => x.startsWith("src/components/ownerTools/"))) {
      for (const m of fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(FIELD_NAME)) {
        names.add(m[1]!);
      }
    }
    expect([...names].sort()).toEqual(
      [
        "broker_name",
        "broker_template",
        "code",
        "cost",
        "csv_file",
        "csv_text",
        "date",
        "fees",
        "market",
        "note",
        "price",
        "qty",
        "real_capital",
        "reason",
        "side",
        "trade_id",
      ].sort(),
    );
  });

  it("self-test: the patterns catch what they are meant to catch", () => {
    for (const n of [
      "password",
      "api_key",
      "apiKey",
      "access-token",
      "pin",
      "account_number",
      "secret",
    ]) {
      expect(CREDENTIAL_NAME.test(n), n).toBe(true);
    }
    for (const n of ["code", "qty", "real_capital", "broker_template", "mapping", "spinner"]) {
      expect(CREDENTIAL_NAME.test(n), n).toBe(false);
    }
    expect(PASSWORD_TYPE.test('<input type="password" />')).toBe(true);
    expect(PASSWORD_TYPE.test('<input autoComplete="current-password" />')).toBe(true);
    expect([...'<input\n name="a_token"\n />'.matchAll(FIELD_NAME)].map((m) => m[1])).toEqual([
      "a_token",
    ]);
  });

  it("a broker address that carries a credential is refused", () => {
    for (const k of [
      "api_key",
      "token",
      "apikey",
      "password",
      "secret",
      "session",
      "auth",
      "sig",
    ]) {
      expect(validBrokerTemplate(`https://broker.example/t?c={code}&${k}=1`).ok, k).toBe(false);
    }
    expect(validBrokerTemplate("https://user:pw" + "@broker.example/t?c={code}").ok).toBe(false);
    expect(validBrokerTemplate("https://broker.example/t?c={code}").ok).toBe(true);
  });
});
