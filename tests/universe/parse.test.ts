// @vitest-environment node
// D-067: the listed-companies CSV parser (synthetic files only, SEC-110).
import { describe, expect, it } from "vitest";
import {
  MAX_CSV_CHARS,
  MAX_NAME,
  parseListedCompanies,
  splitCsv,
} from "@/lib/data/universe/parse.mjs";
import { cos, csvOf, HEADER, PREAMBLE } from "./helpers";

const ok = (text: unknown) => {
  const r = parseListedCompanies(text);
  if (!r.ok) throw new Error("expected ok");
  return r;
};
const z = (i: number) => `ZZ${String(i).padStart(2, "0")}`;
const goodRows = (n: number) => Array.from({ length: n }, (_, i) => `Synthetic ${i},${z(i)},B`);

describe("splitCsv", () => {
  it("handles quotes, escaped quotes, commas, CRLF, a missing final newline and blank lines", () => {
    expect(splitCsv('a,"b,c","d""e"\r\n\r\nx,y,z')).toEqual([
      ["a", "b,c", 'd"e'],
      ["x", "y", "z"],
    ]);
    expect(splitCsv("")).toEqual([]);
    expect(splitCsv('"multi\nline",b')).toEqual([["multi\nline", "b"]]);
    expect(splitCsv("a,\nb")).toEqual([["a", ""], ["b"]]);
    expect(splitCsv('a"b,c')).toEqual([['a"b', "c"]]); // a quote inside an unquoted field is literal
    expect(splitCsv("a\r")).toEqual([["a"]]);
  });
});

describe("parseListedCompanies", () => {
  it("parses a good file with a preamble line and the header", () => {
    const r = ok(
      csvOf([
        { code: "ZZAA", name: "Synthetic Alpha Ltd", industry: "Materials" },
        { code: "ZZBB", name: 'Synthetic "Beta", Inc', industry: "Banks" },
      ]),
    );
    expect(r.rows).toEqual([
      { code: "ZZAA", name: "Synthetic Alpha Ltd", industry: "Materials" },
      { code: "ZZBB", name: 'Synthetic "Beta", Inc', industry: "Banks" },
    ]);
    expect(r.stats).toEqual({ records: 2, valid: 2, duplicates: 0, badCodes: 0, malformed: 0 });
  });

  it("accepts no preamble, CRLF line ends, a BOM, odd header case and spacing", () => {
    expect(ok(csvOf(cos(3), { preamble: false, eol: "\r\n" })).rows).toHaveLength(3);
    expect(ok("﻿" + csvOf(cos(2))).rows).toHaveLength(2);
    const c = ok(
      `${PREAMBLE}\n\n  COMPANY NAME , ASX Code,gics industry group \nSynthetic X,ZZXX,Banks\n`,
    );
    expect(c.rows).toEqual([{ code: "ZZXX", name: "Synthetic X", industry: "Banks" }]);
  });

  it("an empty industry becomes null", () => {
    expect(ok(`${HEADER}\nSynthetic X,ZZXX,\n`).rows[0].industry).toBeNull();
  });

  it("rejects anything that is not the expected file as unrecognised_format", () => {
    const bad: unknown[] = [
      "",
      42,
      null,
      undefined,
      "<html><body>Just a moment...</body></html>",
      '{"data":[]}',
      "Code,Name\nZZAA,Synthetic\n", // wrong header
      "Company name,ASX code\nSynthetic,ZZAA\n", // header too short
      `${HEADER}\n`, // header only, no rows
      `a\nb\nc\n${HEADER}\nSynthetic,ZZAA,Banks\n`, // header after too many preamble lines
      "Synthetic,ZZAA,Banks\n", // rows without a header
      "x".repeat(MAX_CSV_CHARS + 1),
    ];
    for (const t of bad) {
      expect(parseListedCompanies(t), String(t).slice(0, 30)).toEqual({
        ok: false,
        error: "unrecognised_format",
      });
    }
  });

  it("skips and counts duplicates (first wins), bad codes and malformed rows", () => {
    const r = ok(
      [
        HEADER,
        ...goodRows(100),
        "Duplicate Name,ZZ00,Banks", // duplicate
        "Lower,zz41,Banks", // bad code (lower case)
        "Too long,ZZTOOLONG,Banks", // bad code (length)
        ",ZZ42,Banks", // empty name
      ].join("\n"),
    );
    expect(r.rows).toHaveLength(100);
    expect(r.rows[0].name).toBe("Synthetic 0");
    expect(r.stats).toMatchObject({ duplicates: 1, badCodes: 2, malformed: 1, valid: 100 });
  });

  it("more than 5 % skipped rows rejects the whole file", () => {
    const rows = goodRows(20);
    expect(parseListedCompanies([HEADER, ...rows, "Bad,not a code,B"].join("\n")).ok).toBe(true); // 1 of 21
    expect(
      parseListedCompanies([HEADER, ...rows, "Bad,not a code,B", "Bad2,@@,B"].join("\n")).ok,
    ).toBe(false); // 2 of 22
  });

  it("a file where every row is bad is unrecognised", () => {
    expect(parseListedCompanies(`${HEADER}\nA,lower,B\nC,!!,D\n`).ok).toBe(false);
  });

  it("wrong field count, control characters and over-long fields are malformed rows", () => {
    const r = ok(
      [
        HEADER,
        ...goodRows(100),
        "OnlyTwo,ZY01",
        "Four,ZY02,B,extra",
        "Ctl\u0001name,ZZ92,B",
        `${"N".repeat(MAX_NAME + 1)},ZY04,B`,
        `Name,ZY05,${"I".repeat(101)}`,
      ].join("\n"),
    );
    expect(r.stats.malformed).toBe(5);
    expect(r.rows).toHaveLength(100);
  });

  it("too many records is rejected", () => {
    const rows = Array.from({ length: 20_005 }, (_, i) => `N,Z${String(i).padStart(5, "0")},B`);
    expect(parseListedCompanies([HEADER, ...rows].join("\n"))).toEqual({
      ok: false,
      error: "unrecognised_format",
    });
  });
});
