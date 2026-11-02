// CTX-040 text labels (M15 P5): mock provider, enum and span validation, budget, switch, persistence.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import type { AnnouncementRow } from "@/lib/agents/decisionView";
import type { EventRow } from "@/lib/agents/schema";
import { getValidation, labelsForAnnouncement } from "@/lib/cortex/store/labels";
import { filterMany } from "@/lib/llm/injection";
import {
  createMockProvider,
  promptSha,
  type LlmProvider,
  type MockFixture,
} from "@/lib/llm/providers";
import { buildPrompt } from "@/lib/llm/router";
import { MemoryStore } from "@/lib/llm/store";
import {
  buildLabelRequest,
  checkLabel,
  makeLabelHook,
  persistLabelOutcome,
  produceLabels,
  textLabelsEnabled,
  TEXT_LABEL_TEMPLATE_VERSION,
  type LabelInput,
} from "@/lib/llm/textLabels";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { makeRouter } from "./helpers";

afterEach(cleanupTempDbs);

const MODEL = "mock-1";
const INPUT: LabelInput = {
  market: "AU",
  d: "2026-03-05",
  announcementId: "asx|ZZ-1",
  code: "ZZA",
  category: "guidance",
  priceSensitive: true,
  title: "ZZA raises FY guidance",
  body: "ZZA now expects revenue growth of 10 per cent. The board is confident.",
  manifestId: "mf-1",
};
const GOOD = {
  guidance: { value: "up", span: "now expects revenue growth of 10 per cent" },
  event_confirm: { value: "confirmed", span: "ZZA raises FY guidance" },
  tone: { value: "positive", span: "The board is confident." },
};

function fixtures(i: LabelInput, answer: unknown): Record<string, MockFixture> {
  const req = buildLabelRequest(i);
  const prompt = buildPrompt(req.task, req.facts, filterMany(req.untrusted).texts, false);
  const sha = promptSha("R2", MODEL, TEXT_LABEL_TEMPLATE_VERSION, prompt);
  return { [sha]: { text: JSON.stringify(answer), tokensIn: 120, tokensOut: 60 } };
}

function setup(answer: unknown, store = new MemoryStore(), input: LabelInput = INPUT) {
  let calls = 0;
  const base = createMockProvider({
    model: MODEL,
    roles: ["R2"],
    fixtures: fixtures(input, answer),
  });
  const provider: LlmProvider = {
    ...base,
    call: (req, signal) => {
      calls += 1;
      return base.call(req, signal);
    },
  };
  const { router } = makeRouter("mock", [provider], store);
  const deps = {
    router,
    providers: [provider],
    enabled: true,
    now: () => new Date("2026-03-05T10:00:00.000Z"),
  };
  return { deps, store, calls: () => calls };
}

describe("textLabelsEnabled", () => {
  it("is on in staging only, with an explicit off", () => {
    expect(textLabelsEnabled({ PRAXIS_ENV: "staging" })).toBe(true);
    expect(textLabelsEnabled({ PRAXIS_ENV: "staging", PRAXIS_TEXT_LABELS: "off" })).toBe(false);
    expect(textLabelsEnabled({ PRAXIS_ENV: "production" })).toBe(false);
    expect(textLabelsEnabled({})).toBe(false);
  });
});

describe("checkLabel", () => {
  const text = "ZZA raises FY guidance\nZZA now expects revenue growth";
  it("accepts an in-enum label with a span in the text (whitespace folded)", () => {
    expect(checkLabel("tone", { value: "positive", span: "FY  guidance" }, text).ok).toBe(true);
  });
  it("rejects out-of-enum, missing span and span not in text", () => {
    expect(checkLabel("tone", { value: "bullish", span: "FY guidance" }, text)).toMatchObject({
      reason: "enum",
    });
    expect(checkLabel("tone", { value: "positive", span: null }, text)).toMatchObject({
      reason: "span_missing",
    });
    expect(checkLabel("tone", { value: "positive", span: "profit doubled" }, text)).toMatchObject({
      reason: "span_not_in_text",
    });
  });
  it("allows no span only for none / unclear", () => {
    expect(checkLabel("guidance", { value: "none", span: null }, text).ok).toBe(true);
    expect(checkLabel("event_confirm", { value: "unclear", span: null }, text).ok).toBe(true);
  });
});

describe("produceLabels", () => {
  it("returns three labels with produced_at, manifest id and a validation record each", async () => {
    const { deps } = setup(GOOD);
    const out = await produceLabels(deps, INPUT);
    expect(out.status).toBe("done");
    expect(out.accepted.map((a) => a.label.labelKind)).toEqual([
      "guidance",
      "event_confirm",
      "tone",
    ]);
    for (const a of out.accepted) {
      expect(a.label.producedAt).toBe("2026-03-05T10:00:00.000Z");
      expect(a.label.manifestId).toBe("mf-1");
      expect(a.label.modelId).toBe("mock/mock-1");
      expect(a.label.validationId).toBe(a.validation.validationId);
      expect(a.validation.result).toMatchObject({ ok: true });
    }
  });

  it("rejects an out-of-enum label and a span not in the text, recording failed validation", async () => {
    const { deps } = setup({
      guidance: { value: "sideways", span: "now expects revenue growth of 10 per cent" },
      event_confirm: { value: "confirmed", span: "ZZA raises FY guidance" },
      tone: { value: "positive", span: "profit doubled overnight" },
    });
    const out = await produceLabels(deps, INPUT);
    expect(out.accepted.map((a) => a.label.labelKind)).toEqual(["event_confirm"]);
    expect(
      out.rejected.map((r) => [r.labelKind, (r.validation.result as { reason: string }).reason]),
    ).toEqual([
      ["guidance", "enum"],
      ["tone", "span_not_in_text"],
    ]);
    for (const r of out.rejected) expect(r.validation.result).toMatchObject({ ok: false });
  });

  it("an unusable answer records one failed validation and no label", async () => {
    const { deps } = setup({ nope: 1 });
    const out = await produceLabels(deps, INPUT);
    expect(out.status).toBe("invalid_answer");
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  it("labels off: no LLM call and no rows", async () => {
    const { deps, calls, store } = setup(GOOD);
    const out = await produceLabels({ ...deps, enabled: false }, INPUT);
    expect(out).toEqual({ status: "off", accepted: [], rejected: [] });
    expect(calls()).toBe(0);
    expect(store.rows).toEqual([]);
  });

  it("a non price-sensitive item makes no call", async () => {
    const { deps, calls } = setup(GOOD);
    const out = await produceLabels(deps, { ...INPUT, priceSensitive: false });
    expect(out.status).toBe("not_price_sensitive");
    expect(calls()).toBe(0);
  });

  it("respects the budget reservation: exhausted role budget means no call and no rows", async () => {
    const store = new MemoryStore();
    store.rows.push({
      id: "x",
      role: "R2",
      provider: "mock",
      modelId: MODEL,
      fallbackDepth: "0",
      tokensIn: defaultAgentParams().llm.roleDailyTokens.R2,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: "AU",
      d: "2026-03-05",
    });
    const { deps, calls } = setup(GOOD, store);
    const out = await produceLabels(deps, INPUT);
    expect(out).toEqual({ status: "budget_exhausted", accepted: [], rejected: [] });
    expect(calls()).toBe(0);
  });

  it("rules-only router mode: no LLM labels", async () => {
    const { router } = makeRouter("rules-only", []);
    const out = await produceLabels(
      { router, enabled: true, now: () => new Date("2026-03-05T10:00:00.000Z") },
      INPUT,
    );
    expect(out.status).toBe("no_llm");
  });
});

describe("persistence and the hook", () => {
  it("writes labels with validation first (insert guard passes) and failed validations", async () => {
    const db = await freshDb("main");
    const { deps } = setup({ ...GOOD, tone: { value: "positive", span: "not in the text" } });
    const out = await produceLabels(deps, INPUT);
    await persistLabelOutcome(db, out);
    const rows = await labelsForAnnouncement(db, "AU", INPUT.announcementId);
    expect(rows.map((r) => r.labelKind)).toEqual(["event_confirm", "guidance"]);
    for (const r of rows) {
      expect(r.manifestId).toBe("mf-1");
      expect(await getValidation(db, r.validationId)).not.toBeNull();
    }
    const failed = out.rejected[0]!.validation;
    expect((await getValidation(db, failed.validationId))?.result).toMatchObject({ ok: false });
  });

  it("the A2 hook labels a price-sensitive event row and never throws", async () => {
    const db = await freshDb("main");
    const titleOnly: LabelInput = { ...INPUT, body: undefined };
    const answer = {
      guidance: { value: "up", span: "raises FY guidance" },
      event_confirm: { value: "confirmed", span: "ZZA raises FY guidance" },
      tone: { value: "positive", span: "ZZA raises" },
    };
    const { deps } = setup(answer, new MemoryStore(), titleOnly);
    const hook = makeLabelHook(deps, db, () => "mf-1");
    const row = {
      market: "AU",
      source: "asx",
      ann_id: "ZZ-1",
      code: "ZZA",
      day0_d: "2026-03-05",
      category: "guidance",
      price_sensitive: 1,
    } as unknown as EventRow;
    const ann = { title: INPUT.title } as unknown as AnnouncementRow;
    await hook(row, ann);
    expect(await labelsForAnnouncement(db, "AU", "asx|ZZ-1")).toHaveLength(3);
    const broken = makeLabelHook(
      { ...deps, router: { route: () => Promise.reject(new Error("x")) } },
      db,
      () => "m",
    );
    await expect(broken(row, ann)).resolves.toBeUndefined();
  });
});
