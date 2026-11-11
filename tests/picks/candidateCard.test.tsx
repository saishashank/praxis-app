// D-984: a candidate-measure pick on its card: the "Candidate measure" badge and "none yet" for past
// similar trades instead of cases; an ordinary pick has neither. Synthetic ZZ data.
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
  id: "2026-10-20.balanced.3",
  rank: 3,
  familyName: "Follow the trend",
  familyInfo: null,
  stopPpm: -50_000,
  aimPpm: 100_000,
  size: m("1000000000"),
  riskAtStop: m("50000000"),
  outcome: null,
  stock: "ZZOTH",
  company: "Zed Other Group",
  family: "F1",
  tier: "U1",
  label: "UNVALIDATED",
  buyUpTo: m("10050000"),
  stop: m("9500000"),
  aim: m("11000000"),
  validUntil: "2026-10-21",
  scenario: null,
  aimReachPpm: null,
  timeFrameSessions: 20,
  basedOn: ["From the candidate measure: heavy trading without news — being tested, not proven."],
  cardHref: null,
  chance: { kind: "no_history" } as PickRowView["chance"],
  chanceText: "Not enough history yet",
  expectedGainPpm: null,
  stamp: "Published 18:10 on Tue 20 Oct from closing prices",
  candidate: true,
  ...over,
});

describe("PickCard for a candidate pick (D-984)", () => {
  it("shows the badge and says there are no past trades of the measure yet", () => {
    render(<PickCard pick={view()} masked={false} beatsLuck={false} />);
    expect(screen.getByTestId("candidate-badge")).toHaveTextContent("Candidate measure");
    expect(screen.getByText("none yet: a candidate measure being tested")).toBeInTheDocument();
    expect(screen.getByText(/From the candidate measure/)).toBeInTheDocument();
  });

  it("an ordinary pick has no badge", () => {
    render(<PickCard pick={view({ candidate: false })} masked={false} beatsLuck={false} />);
    expect(screen.queryByTestId("candidate-badge")).toBeNull();
    expect(screen.getByText("not enough similar cases yet")).toBeInTheDocument();
  });
});
