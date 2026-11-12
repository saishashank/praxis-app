// @vitest-environment node
// M20 US1 (D-1166): the plain-ESM classifier of the batch-1 day (`sources/us/classify.mjs`, no TypeScript build) and A5's
// TypeScript `classify` are the same rule. Both run over the 50 hand-labelled fixture items and must agree on every
// field, so the copy cannot drift.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { categoryMapReader, classify, type AnnouncementItem } from "@/lib/cortex/profileReaders";
import { classifyItem } from "@/lib/data/sources/us/classify.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

type Fixture = {
  id: string;
  expect: { category: string; materiality: number; verifiable: boolean };
} & AnnouncementItem;
const ITEMS = (
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../fixtures/markets/us/announcements-50.json"),
      "utf8",
    ),
  ) as { items: Fixture[] }
).items;
const map = categoryMapReader(staticProfile("US"))!;

describe("classify.mjs equals profileReaders.classify", () => {
  it.each(ITEMS.map((i) => [i.id, i] as const))("%s", (_id, item) => {
    const a = classify(map, item);
    const b = classifyItem(map, item);
    expect(b).toEqual(a);
    expect({ category: b.category, materiality: b.materiality, verifiable: b.verifiable }).toEqual(
      item.expect,
    );
  });

  it("the evidence flags lift a contract and verify results the same way in both", () => {
    const contract = {
      form: "8-K",
      item: ["1.01"],
      title: "x",
      facts: { valueDisclosed: true, counterpartyDisclosed: true },
    };
    expect(classifyItem(map, contract)).toEqual(classify(map, contract));
    expect(classifyItem(map, contract).materiality).toBe(3);
    const results = {
      form: "8-K",
      item: ["2.02"],
      title: "Results",
      facts: { statementsParsed: true },
    };
    expect(classifyItem(map, results)).toEqual(classify(map, results));
    expect(classifyItem(map, results).verifiable).toBe(true);
  });
});
