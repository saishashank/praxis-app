// Pill (UXR-045, UXR-051): a short label that always carries text, never colour alone. Kinds:
// state (Running, Paused, ...), tier (P0-P2), thesis (green/amber/red), validation (ARN-086 labels),
// family (two-letter code), sector, status (ok / warn / bad / neutral). The colour comes from the token
// groups; the optional two-letter `mark` is shown in High contrast (UXR-057) where hue alone is not
// enough. The older badges in Badges.tsx keep their M7 look until their pages are redesigned.
import type { ReactNode } from "react";
import { cn } from "./cn";
import { hueStyle, TILE_BG } from "./hue";

export type PillKind = "state" | "tier" | "thesis" | "validation" | "family" | "sector" | "status";

type Entry = { hue: string; text: string };

const STATE: Record<string, Entry> = {
  running: { hue: "status-running", text: "Running" },
  paused: { hue: "status-paused", text: "Paused" },
  target: { hue: "status-target", text: "Target reached" },
  stopped: { hue: "status-stopped", text: "Stopped" },
  shadow: { hue: "status-shadow", text: "Shadow" },
  allowed: { hue: "status-allowed", text: "Allowed" },
  livetested: { hue: "status-livetested", text: "Live-tested" },
};
const TIER: Record<string, Entry> = {
  P0: { hue: "tier-p0", text: "P0" },
  P1: { hue: "tier-p1", text: "P1" },
  P2: { hue: "tier-p2", text: "P2" },
};
const STATUS: Record<string, Entry> = {
  ok: { hue: "positive", text: "OK" },
  warn: { hue: "tier-p1", text: "Due soon" },
  bad: { hue: "negative", text: "Overdue" },
  neutral: { hue: "outcome-flat", text: "Not started" },
};
// Thesis and validation reuse the older, separate families (never the gain/loss pair, UXN-001); those
// tokens have no -fill / -text variants, so they are mapped to the local properties directly below.
const THESIS: Record<string, { token: string; text: string }> = {
  green: { token: "breaker-green", text: "Green" },
  amber: { token: "breaker-amber", text: "Amber" },
  red: { token: "breaker-red", text: "Red" },
};
const VALIDATION: Record<string, { token: string; text: string }> = {
  UNVALIDATED: { token: "label-unvalidated", text: "Unvalidated" },
  "PASSED-BACKTEST": { token: "label-passed", text: "Passed backtest" },
  "CONSISTENT-FORWARD": { token: "label-consistent", text: "Consistent forward" },
  FAILED: { token: "label-failed", text: "Failed" },
  "NOT-DEMONSTRATED": { token: "label-notdemo", text: "Not demonstrated" },
  UNVALIDATABLE: { token: "label-unvalidatable", text: "Unvalidatable" },
};

function legacyStyle(token: string) {
  return {
    "--h-fill": `var(--color-${token})`,
    "--h-text": `var(--color-${token})`,
    "--h-on": "var(--color-bg)",
  } as React.CSSProperties;
}

export type PillProps = {
  kind: PillKind;
  /**
   * state: running|paused|target|stopped|shadow|allowed|livetested; tier: P0|P1|P2;
   * thesis: green|amber|red; validation: an ARN-086 label; family: family code (br, vc, nd, ...);
   * sector: sector key (tech, energy, ...); status: ok|warn|bad|neutral.
   */
  value: string;
  /** Text shown; defaults to the standard word for the value. Always rendered. */
  children?: ReactNode;
  /** Two-letter mark shown in High contrast (defaults to the family code). */
  mark?: string;
  title?: string;
  className?: string;
};

export function Pill({ kind, value, children, mark, title, className }: PillProps) {
  let style: React.CSSProperties;
  let defaultText: string = value;
  const key = kind === "family" || kind === "sector" ? value.toLowerCase() : value;
  if (kind === "thesis" || kind === "validation") {
    const e = (kind === "thesis" ? THESIS : VALIDATION)[key];
    style = legacyStyle(e?.token ?? "label-unvalidated");
    defaultText = e?.text ?? value;
  } else {
    let e: Entry | undefined;
    if (kind === "state") e = STATE[key.toLowerCase()];
    else if (kind === "tier") e = TIER[key.toUpperCase()];
    else if (kind === "status") e = STATUS[key.toLowerCase()];
    else if (kind === "family") e = { hue: `family-${key}`, text: key.toUpperCase() };
    else e = { hue: `sector-${key}`, text: value };
    style = hueStyle(e?.hue ?? "outcome-flat");
    defaultText = e?.text ?? value;
  }
  const m = mark ?? (kind === "family" ? value.slice(0, 2).toUpperCase() : undefined);
  return (
    <span
      title={title}
      data-kind={kind}
      style={{ ...style, background: TILE_BG }}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs leading-tight font-semibold break-words text-[var(--h-text)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="ui-pill-dot size-2 shrink-0 rounded-full bg-[var(--h-fill)]"
      />
      {m ? (
        <span aria-hidden="true" className="ui-mark font-mono">
          {m}
        </span>
      ) : null}
      <span>
        {children === undefined || children === null || children === "" ? defaultText : children}
      </span>
    </span>
  );
}
