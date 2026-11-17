// Owner 2026-11-16: the pick cards show the full name, the entry price, the current price with its
// change from entry, and the aim and stop as money and percent. A masked viewer sees percentages only.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PickCard } from "@/app/(app)/picks/PickCard";
import type { PickRowView } from "@/lib/ui/loaders/picks";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const m = (micro: string) => ({ micro, currency: "AUD" as const, simulated: true as const });
const view = (over: Partial<PickRowView> = {}): PickRowView => ({
  id: "2026-10-20.balanced.1",
  rank: 1,
  familyName: "Follow the trend",
  familyInfo: null,
  stopPpm: -110_000,
  aimPpm: 180_000,
  entry: m("1230000"),
  entryBought: false,
  lastCloseD: "2026-11-12",
  now: { money: m("1300000"), changePpm: 56_911, label: "Delayed, 13:05" },
  size: m("1000000000"),
  riskAtStop: m("50000000"),
  outcome: null,
  stock: "ZZUP",
  company: "Zed Upward Holdings",
  family: "F1",
  tier: "U1",
  label: "UNVALIDATED",
  buyUpTo: m("1240000"),
  stop: m("1100000"),
  aim: m("1450000"),
  validUntil: "2026-11-16",
  scenario: null,
  aimReachPpm: null,
  timeFrameSessions: 20,
  basedOn: [],
  cardHref: null,
  chance: { kind: "no_history" } as PickRowView["chance"],
  chanceText: "Not enough history yet",
  expectedGainPpm: null,
  stamp: "Published",
  candidate: false,
  ...over,
});

describe("/picks card: entry, now, aim and stop", () => {
  it("shows the name, entry, current price and aim and stop with percent", () => {
    render(<PickCard pick={view()} masked={false} beatsLuck={false} />);
    const card = screen.getByTestId("pick-card");
    expect(card).toHaveTextContent("ZZUP · Zed Upward Holdings");
    expect(screen.getByTestId("entry-line")).toHaveTextContent(
      "Entry about A$1.23 (last close Thu 12 Nov)",
    );
    expect(screen.getByTestId("now-line")).toHaveTextContent("Now A$1.30 (+5.7%), Delayed, 13:05");
    expect(card).toHaveTextContent("Stop-loss A$1.10 (-11%)");
    expect(card).toHaveTextContent("Aim A$1.45 (+18%)");
  });

  it("says Bought at once the pick was bought", () => {
    render(
      <PickCard
        pick={view({
          entry: m("1200000"),
          entryBought: true,
          outcome: {
            state: "bought",
            entry: m("1200000"),
            exitReason: null,
            netPpm: null,
            withdrawnReason: null,
          },
        })}
        masked={false}
        beatsLuck={false}
      />,
    );
    expect(screen.getByTestId("entry-line").textContent).toBe("Bought at A$1.20");
  });

  it("leaves out the now line when there is no current price", () => {
    render(<PickCard pick={view({ now: null })} masked={false} beatsLuck={false} />);
    expect(screen.queryByTestId("now-line")).toBeNull();
    expect(screen.getByTestId("entry-line")).toBeInTheDocument();
  });

  it("masked: percentages only, no name, price or date", () => {
    const { container } = render(
      <PickCard
        pick={view({
          stock: "Stock A",
          company: null,
          entry: null,
          lastCloseD: null,
          stop: null,
          aim: null,
          buyUpTo: null,
          size: null,
          riskAtStop: null,
          now: { money: null, changePpm: 56_911, label: null },
        })}
        masked
        beatsLuck={false}
      />,
    );
    expect(screen.queryByTestId("entry-line")).toBeNull();
    expect(screen.getByTestId("now-line").textContent).toBe("Now +5.7% from entry");
    expect(container.textContent).toContain("(+18%)");
    expect(container.textContent).toContain("(-11%)");
    expect(container.textContent).not.toMatch(/Zed|ZZUP|A\$|Delayed|last close/);
  });
});
