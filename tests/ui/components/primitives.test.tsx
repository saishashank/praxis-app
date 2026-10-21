// TST-128 component tests (M7 T5): long text, zero, negative, missing values; roles and labels;
// empty / stale / masked states; no horizontal scroll at 360 px at unit level (no fixed pixel widths,
// wrapping classes, stacked card list below 600 px); no border on surface-2 (D-130).
import { render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { GlyphBar } from "@/components/charts/GlyphBar";
import { KpiRow, KpiTile } from "@/components/ui/Kpi";
import {
  AlertTierBadge,
  BreakerStatus,
  GradeBadge,
  RegimeBadge,
  ValidationBadge,
} from "@/components/ui/Badges";
import { Breadcrumb, Chips, Tabs } from "@/components/ui/Nav";
import { Banner, EmptyState, ShowDetails, StaleBanner } from "@/components/ui/States";
import {
  GainLoss,
  Masked,
  Money,
  NotMeasured,
  Percent,
  SimulatedLabel,
} from "@/components/ui/Values";
import { staleness } from "@/lib/view/staleness";

const LONG = "Averyveryverylongunbrokenstrategyname".repeat(8);

describe("cn", () => {
  it("joins truthy parts only", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
    expect(cn()).toBe("");
  });
});

describe("Button", () => {
  it("is a real button, not a submit by default", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });
  it("disabled with a reason shows the reason and links it", () => {
    render(
      <Button id="b1" disabledReason="Only the Owner can do this">
        Revert
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Revert" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription("Only the Owner can do this");
  });
});

describe("Money, GainLoss, Percent", () => {
  it("formats zero, negative and large cents; zero has no sign", () => {
    const { container } = render(
      <>
        <Money cents={0} />
        <Money cents={-123456} />
        <Money cents={60000} />
      </>,
    );
    const t = [...container.querySelectorAll("[data-money]")].map((e) => e.textContent);
    expect(t).toEqual(["A$0.00", "-A$1,234.56", "A$600.00"]);
  });
  it("missing money says Not measured yet, never 0", () => {
    render(<Money cents={null} />);
    expect(screen.getByText("Not measured yet")).toBeInTheDocument();
    expect(screen.queryByText("A$0.00")).toBeNull();
  });
  it("masked money shows the lock text and no figure", () => {
    const { container } = render(<Money cents={99999} masked />);
    expect(container).toHaveTextContent("Hidden for your role");
    expect(container).not.toHaveTextContent("999");
  });
  it("GainLoss gives sign, arrow and words, not colour alone", () => {
    render(
      <>
        <GainLoss value={1250} />
        <GainLoss value={-1250} />
        <GainLoss value={0} />
      </>,
    );
    expect(screen.getByRole("img", { name: "gain: +A$12.50" })).toHaveTextContent("▲");
    expect(screen.getByRole("img", { name: "loss: -A$12.50" })).toHaveTextContent("▼");
    expect(screen.getByRole("img", { name: "no change: A$0.00" })).toHaveTextContent("–");
  });
  it("GainLoss handles missing and masked", () => {
    const { container } = render(
      <>
        <GainLoss value={undefined} />
        <GainLoss value={5} masked />
      </>,
    );
    expect(container).toHaveTextContent("Not measured yet");
    expect(container).toHaveTextContent("Hidden for your role");
    expect(screen.queryByRole("img", { name: /gain/ })).toBeNull();
  });
  it("Percent: zero, negative, missing", () => {
    const { container } = render(
      <>
        <Percent value={0} />
        <Percent value={-1.5} />
        <Percent value={null} />
      </>,
    );
    expect(container).toHaveTextContent("0.00%");
    expect(container).toHaveTextContent("-1.50%");
    expect(container).toHaveTextContent("Not measured yet");
  });
  it("SimulatedLabel always shows the word and an explainer link", () => {
    render(<SimulatedLabel />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /simulated mean/i })).toHaveAttribute("href");
  });
  it("Masked and NotMeasured render their text", () => {
    render(
      <>
        <Masked label="Another stock" />
        <NotMeasured />
      </>,
    );
    expect(screen.getByText("Another stock")).toBeInTheDocument();
  });
});

describe("KpiRow", () => {
  it("is a labelled description list; missing and masked tiles are honest", () => {
    render(
      <KpiRow label="Totals">
        <KpiTile label="Value" currency="AUD" value="A$600.00" />
        <KpiTile label="Return" value={null} />
        <KpiTile label="Best stock" value="XYZ" masked />
        <KpiTile label={LONG} value={LONG} />
      </KpiRow>,
    );
    const list = screen.getByLabelText("Totals");
    expect(list.tagName).toBe("DL");
    expect(within(list).getByText("(AUD)")).toBeInTheDocument();
    expect(within(list).getByText("Not measured yet")).toBeInTheDocument();
    expect(within(list).queryByText("XYZ")).toBeNull();
    expect(list.querySelector("div.min-w-0")).not.toBeNull();
  });
});

describe("badges", () => {
  it("ValidationBadge shows friendly and exact label, plus a separate luck flag", () => {
    render(<ValidationBadge label="UNVALIDATED" possibleLuck />);
    expect(screen.getByText("Not proven yet")).toBeInTheDocument();
    expect(screen.getByText("UNVALIDATED")).toBeInTheDocument();
    expect(screen.getByText("Possibly luck")).toBeInTheDocument();
  });
  it("ValidationBadge with an unknown label falls back without crashing", () => {
    render(<ValidationBadge label="???" />);
    expect(screen.getByText("Not proven yet")).toBeInTheDocument();
  });
  it("RegimeBadge shows Market mood, friendly and official names; unknown is honest", () => {
    const { rerender } = render(<RegimeBadge regime="RISK-OFF" />);
    expect(screen.getByText("Market mood")).toBeInTheDocument();
    expect(screen.getByText("Nervous")).toBeInTheDocument();
    expect(screen.getByText("RISK-OFF")).toBeInTheDocument();
    rerender(<RegimeBadge regime={null} />);
    expect(screen.getByText("Not enough history yet")).toBeInTheDocument();
  });
  it("BreakerStatus uses a shape and words, not only colour", () => {
    const { container } = render(
      <>
        <BreakerStatus status="green" />
        <BreakerStatus status="amber" />
        <BreakerStatus status="red" />
        <BreakerStatus status={undefined} />
      </>,
    );
    expect(container).toHaveTextContent("None");
    expect(container).toHaveTextContent("Watch");
    expect(container).toHaveTextContent("Triggered");
    expect(container).toHaveTextContent("Not available");
    expect(container.textContent).toMatch(/●.*▲.*■/);
  });
  it("GradeBadge and AlertTierBadge", () => {
    const { container } = render(
      <>
        <GradeBadge grade="L2" />
        <GradeBadge grade="L9" />
        <AlertTierBadge tier="P0" />
      </>,
    );
    expect(container).toHaveTextContent("L2");
    expect(container).toHaveTextContent("Grade n/a");
    expect(container).toHaveTextContent("Urgent");
  });
  it("never uses the gain/loss tokens (UXN-001) and never a border on surface-2 (D-130)", () => {
    const { container } = render(
      <>
        <ValidationBadge label="FAILED" />
        <RegimeBadge regime="SHOCK" />
        <BreakerStatus status="red" />
        <GradeBadge grade="L1" />
        <AlertTierBadge tier="P1" />
      </>,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/text-(positive|negative)/);
    expect(html).not.toMatch(/\bborder\b/);
    expect(html).toContain("bg-surface-2");
  });
});

type Row = { id: string; name: string; value: number | null };
const ROWS: Row[] = [
  { id: "a", name: "Buy the dip", value: -5 },
  { id: "b", name: LONG, value: 0 },
  { id: "c", name: "No data", value: null },
];
const COLS: Column<Row>[] = [
  { key: "name", header: "Strategy", cell: (r) => r.name, sortHref: "?sort=name", sorted: "asc" },
  {
    key: "value",
    header: "Return",
    align: "right",
    cell: (r) => <GainLoss value={r.value} kind="percent" />,
    sortHref: "?sort=value",
  },
];

describe("DataTable", () => {
  it("renders a captioned table with row headers and aria-sort on the sorted column only", () => {
    render(<DataTable caption="Strategies" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const table = screen.getByRole("table", { name: "Strategies" });
    const heads = within(table).getAllByRole("columnheader");
    expect(heads[0]).toHaveAttribute("aria-sort", "ascending");
    expect(heads[1]).not.toHaveAttribute("aria-sort");
    expect(within(table).getByRole("link", { name: "Return" })).toHaveAttribute(
      "href",
      "?sort=value",
    );
    expect(within(table).getAllByRole("rowheader")).toHaveLength(3);
  });
  it("handles long text, negative, zero and missing cells", () => {
    const { container } = render(
      <DataTable caption="Strategies" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    const table = container.querySelector("table")!;
    expect(table).toHaveTextContent(LONG);
    expect(table).toHaveTextContent("-5.00%");
    expect(table).toHaveTextContent("Not measured yet");
  });
  it("also renders a stacked card list shown only below 600 px, from the same columns", () => {
    const { container } = render(
      <DataTable caption="Strategies" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    const list = container.querySelector("ul")!;
    expect(list.className).toContain("sm:hidden");
    expect(container.querySelector("table")!.className).toMatch(/\bhidden\b.*sm:table/);
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(list).toHaveTextContent("Return");
  });
  it("360 px unit check: no fixed pixel widths, long text wraps", () => {
    const { container } = render(
      <DataTable caption="Strategies" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    expect(container.innerHTML).not.toMatch(/(?:min-)?w-\[\d+px\]|width:\s*\d+px/);
    expect(container.querySelector("ul li")!.className).toContain("break-words");
    expect(container.querySelector("ul li")!.className).toContain("min-w-0");
    expect(container.querySelector("table")!.className).toContain("table-fixed");
  });
  it("shows the empty element when there are no rows", () => {
    render(
      <DataTable
        caption="Strategies"
        columns={COLS}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No rounds yet" />}
      />,
    );
    expect(screen.getByText("No rounds yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Tabs, Chips, Breadcrumb", () => {
  const items = [
    { href: "/picks", label: "Picks", current: true, badge: 3 },
    { href: "/market", label: "Market", badge: 0 },
  ];
  it("Tabs: nav landmark, aria-current on the active link only, badge hidden at zero", () => {
    render(<Tabs label="Sections" items={items} />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("link", { name: /Picks/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Market" })).not.toHaveAttribute("aria-current");
    expect(nav).toHaveTextContent("3");
    expect(within(nav).getByRole("link", { name: "Market" })).toHaveTextContent(/^Market$/);
  });
  it("Chips are links with aria-current", () => {
    render(<Chips label="Filter" items={items} />);
    expect(screen.getByRole("link", { name: "Picks" })).toHaveAttribute("aria-current", "page");
  });
  it("Breadcrumb: last crumb is current, earlier ones link, back link optional", () => {
    render(
      <Breadcrumb
        backHref="/market"
        items={[{ href: "/market", label: "Market" }, { label: LONG }]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Market" })).toHaveAttribute("href", "/market");
    expect(within(nav).getByText(LONG)).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/market");
  });
});

describe("states", () => {
  it("EmptyState shows title, text and action", () => {
    render(
      <EmptyState title="No rounds yet" action={<a href="/x">Go</a>}>
        The strategies start when the market is switched on.
      </EmptyState>,
    );
    expect(screen.getByText("No rounds yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go" })).toBeInTheDocument();
  });
  it("StaleBanner: nothing when fresh, alert with the last good time when stale, no data when missing", () => {
    const now = new Date("2026-10-20T03:00:00Z");
    const fresh = render(<StaleBanner status={staleness("2026-10-20T02:50:00Z", now, 60)} />);
    expect(fresh.container).toBeEmptyDOMElement();
    fresh.unmount();
    const stale = render(<StaleBanner status={staleness("2026-10-18T02:50:00Z", now, 60)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Showing data from");
    stale.unmount();
    render(<StaleBanner status={staleness(null, now, 60)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("No data yet");
  });
  it("Banner roles: info is a status, warning and danger are alerts", () => {
    render(
      <>
        <Banner>Info</Banner>
        <Banner tone="warning">Warn</Banner>
        <Banner tone="danger" title="Bad">
          Danger
        </Banner>
      </>,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
  it("ShowDetails is a native details element, closed by default", () => {
    const { container } = render(<ShowDetails>Hidden stuff</ShowDetails>);
    const d = container.querySelector("details")!;
    expect(d.open).toBe(false);
    expect(within(d).getByText("Show details").tagName).toBe("SUMMARY");
  });
  it("Skeleton is one labelled busy status with decorative bars; line count is bounded", () => {
    const { container } = render(<Skeleton lines={999} label="Loading picks" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading picks")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(12);
  });
  it("Card has a heading at the requested level", () => {
    render(
      <Card title="Totals" headingLevel={3}>
        x
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Totals" })).toBeInTheDocument();
  });
});

describe("GlyphBar", () => {
  it("labels every mark in text and describes the value", () => {
    render(<GlyphBar label="Buy the dip" valueCents={72500} />);
    const img = screen.getByRole("img", { name: /Buy the dip: A\$725\.00/ });
    expect(img.getAttribute("aria-label")).toMatch(/Loss limit A\$300\.00/);
    expect(img.getAttribute("aria-label")).toMatch(/Goal A\$1,200\.00/);
    expect(screen.getByText("Stalled below A$511.00")).toBeInTheDocument();
    expect(screen.getByText("Start A$600.00")).toBeInTheDocument();
  });
  it("negative, zero, above-goal and missing values stay inside the bar", () => {
    const { container, rerender } = render(<GlyphBar label="S" valueCents={-500} />);
    expect(container.querySelector<HTMLElement>("[data-glyph-fill]")!.style.width).toBe("0%");
    rerender(<GlyphBar label="S" valueCents={0} />);
    expect(container.querySelector<HTMLElement>("[data-glyph-fill]")!.style.width).toBe("0%");
    rerender(<GlyphBar label="S" valueCents={200000} />);
    expect(container.querySelector<HTMLElement>("[data-glyph-fill]")!.style.width).toBe("100%");
    rerender(<GlyphBar label="S" valueCents={null} />);
    expect(container.querySelector("[data-glyph-fill]")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("not measured yet"),
    );
  });
});

describe("source hygiene (D-130, D-128)", () => {
  const dir = path.resolve(import.meta.dirname, "../../../src/components/ui");
  const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
  it("no component puts a border class on a surface-2 element", () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/"([^"]*\bbg-surface-2\b[^"]*)"/g)) {
        expect(m[1], `${f}: ${m[1]}`).not.toMatch(/(^|\s)border(-[a-z]+)?(\s|$)/);
      }
    }
  });
  it("imports only the two Radix packages, no motion or icon library", () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const mods = [...src.matchAll(/from "([^".@/][^"]*|@[^"]+)"/g)].map((m) => m[1]!);
      for (const mod of mods) {
        expect(
          mod === "react" ||
            mod === "next/link" ||
            mod.startsWith("@radix-ui/react-dialog") ||
            mod.startsWith("@radix-ui/react-popover") ||
            mod.startsWith("@/"),
          `${f} imports ${mod}`,
        ).toBe(true);
      }
    }
  });
});
