// AT-62 (M17 WP4/WP8; UXN-301..306, NFR-041): shadow honesty of the UI pieces. Every intraday row is
// "Unrated" and "Unvalidated", every quote is "delayed", the chance line says "Not enough history yet"
// while the families are in shadow, and no wording says real-time or buy now. (a) is the e2e theme
// walk (`e2e/picks-sections.spec.ts`, the orchestrator's gate); (c)(d)(e) are in tests/email. Final
// review (Fable, D-479 series). No network, synthetic ZZ codes.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AlertChip } from "@/app/(app)/picks/AlertChip";
import { IntradaySection } from "@/app/(app)/picks/IntradaySection";
import * as T from "@/app/(app)/picks/text";
import { catalystWords } from "@/lib/ui/loaders/pickAlerts";
import { chanceDisplay, chanceLine, NO_HISTORY_TEXT } from "@/lib/picks/chance";
import { CARD_BANNED } from "@/lib/cortex/phrases";

afterEach(cleanup);

const REAL_TIME = /real[- ]?time|live price|buy now|guaranteed/i;

const row = (code: string, movePpm: number) => ({
  code,
  stock: `Stock ${code}`,
  company: null,
  foundTime: "10:30",
  catalyst: catalystWords("results", "positive"),
  materiality: 3,
  movePpm,
  limit: { micro: "1000000", currency: "AUD", simulated: true as const },
  stop: { micro: "900000", currency: "AUD", simulated: true as const },
  quoteTime: "10:50",
  decisionOutcome: null,
  href: null,
});

describe("AT-62 (b) shadow honesty", () => {
  it("intraday rows: Unrated and Unvalidated on every row, delayed quotes, no chance, no real-time", () => {
    const rows = [row("ZZAA", 60000), row("ZZBB", 45000), row("ZZCC", 30000)];
    render(
      <IntradaySection
        model={{
          masked: false,
          session: "2030-03-05",
          today: true,
          lastScan: "10:30",
          total: 3,
          rows,
          more: 0,
          delayMin: 20,
        }}
      />,
    );
    const section = screen.getByTestId("intraday-section");
    const text = section.textContent ?? "";
    expect(text.split("Unrated").length - 1).toBeGreaterThanOrEqual(rows.length);
    expect(text).toContain("Unvalidated");
    expect(text).toMatch(/delayed/);
    expect(text).toContain("20");
    expect(text).not.toMatch(REAL_TIME);
    expect(text).not.toMatch(/chance of a net gain|score|rating:/i);
    for (const banned of CARD_BANNED) expect(text).not.toMatch(banned);
  });

  it("the chance line says Not enough history yet for every shadow pick and never a number", () => {
    for (const status of ["shadow", "suspended"] as const) {
      const line = chanceLine(
        chanceDisplay({
          status,
          p: 0.62,
          lo: 0.55,
          hi: 0.69,
          nEff: 120,
          slopeUb: 1.1,
          hideBelow: 1,
        }),
      );
      expect(line).toContain(NO_HISTORY_TEXT);
      expect(line).not.toMatch(/\d\s*in\s*10|\d+\s*%/);
    }
  });

  it("the alert chip always says the quote is delayed when it names a price event", () => {
    const base = { alertId: "x", limit: null, hitTime: null, reason: null, session: "s" } as const;
    render(<AlertChip chip={{ ...base, state: "hit", hitTime: "14:35" }} />);
    expect(screen.getByTestId("alert-chip").textContent).toMatch(/delayed/);
    expect(screen.getByTestId("alert-chip").textContent).not.toMatch(REAL_TIME);
  });

  it("the section wording carries the shadow labels and never real-time", () => {
    expect(T.INTRADAY_UNRATED).toMatch(/Unrated/);
    expect(T.INTRADAY_UNVALIDATED).toMatch(/Unvalidated/);
    for (const s of [T.TONIGHT_TITLE, T.INTRADAY_TITLE, T.INTRADAY_EXPLAINER, T.INTRADAY_UNRATED, T.INTRADAY_UNVALIDATED]) {
      expect(s).not.toMatch(REAL_TIME);
    }
  });
});
