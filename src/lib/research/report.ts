// Research report writer (M23 R1; D-1610). Pure: a result object in, the markdown of `docs/test-reports/CXA-0xx.md` out,
// in the one format of the design (ten sections in a fixed order). The verdict words are the three of D-1602 and nothing
// else is accepted. Numbers only: the writer refuses text that looks like a private path, so a report can never carry
// where the history lives. Codes and company names are the caller's to leave out (the engine never returns them).
import type { EngineVerdict } from "./eventStudy";

export const VERDICT_WORDS: readonly EngineVerdict[] = ["PASS", "NULL", "INCONCLUSIVE"];

export const REPORT_SECTIONS = [
  "Hypothesis",
  "Pre-registration",
  "Data",
  "Split",
  "n",
  "Statistic",
  "Result",
  "Verdict",
  "Looks",
  "Next",
] as const;

export type ResultRow = {
  readonly window: "development" | "holdout" | "full";
  readonly mean: number | null;
  /** One-sided lower bound at the adjusted level; null where none is taken (for example a holdout-only figure). */
  readonly lower: number | null;
  readonly n: number;
};

export type LookRow = {
  readonly lineage: string;
  readonly market: string;
  readonly date: string;
  readonly sha: string;
  readonly verdict: string;
};

export type ReportInput = {
  readonly item: string;
  readonly title: string;
  readonly lineage: string;
  readonly market: string;
  readonly verdict: string;
  readonly hypothesis: string;
  readonly prereg: {
    readonly file: string;
    readonly sha256: string;
    readonly commit: string;
    readonly date: string;
    readonly runnerCommit: string;
  };
  readonly data: {
    readonly sourceClass: string;
    readonly window: string;
    readonly universe: string;
    readonly knownTime: string;
    readonly caveats: readonly string[];
  };
  readonly split:
    | {
        readonly kind: "split";
        readonly development: { readonly from: string; readonly to: string };
        readonly holdout: { readonly from: string; readonly to: string };
      }
    | { readonly kind: "full"; readonly reason: string };
  readonly n: {
    readonly setups: number;
    readonly sessions: number;
    readonly blocks: number;
    readonly floorSetups: number;
    readonly floorBlocks: number;
    readonly floorMet: boolean;
  };
  readonly statistic: {
    readonly definition: string;
    readonly costProfile: string;
    readonly parcel: string;
    readonly control: string;
    readonly haircut: string;
    /** For a sensitivity variant: the label that every figure carries (for example "Larger account, not your book"). */
    readonly variantLabel?: string | null;
  };
  readonly result: {
    readonly unit: string;
    /** One-sided tail probability behind each lower bound (0.10 / k); null when no bound is shown. */
    readonly alpha: number | null;
    readonly rows: readonly ResultRow[];
  };
  readonly verdictReason: string;
  /** INCONCLUSIVE only: what is missing and what fires the look later. */
  readonly missingData?: string;
  readonly firesLater?: string;
  readonly looks: readonly LookRow[];
  readonly refusals: readonly string[];
  readonly next: string;
};

const PRIVATE_TEXT: readonly RegExp[] = [
  /[A-Za-z]:[\\/]/, // a drive path
  /\\\\[^\\\s]+\\/, // a network path
  /(^|[\s("'`])\/(?:home|Users|mnt|var|data)\//, // a private folder
  /history[\\/]/i, // the history folder
];

/** Throws when text looks like it carries a private path (SEC-110: aggregates, counts and hashes only). */
export function assertNoPrivateText(text: string): void {
  for (const re of PRIVATE_TEXT) {
    if (re.test(text)) throw new Error("a report may not carry a private path");
  }
}

export function assertVerdict(word: string): asserts word is EngineVerdict {
  if (!(VERDICT_WORDS as readonly string[]).includes(word)) {
    throw new Error(`verdict must be one of ${VERDICT_WORDS.join(", ")}`);
  }
}

/** A number for a table cell: whole numbers as is, others to 2 places; null as a dash. */
export function fmtNumber(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString(); // threshold-ok: 2 places for display
}

/** The one-sided confidence level of a tail probability: 0.1 -> "90 %", 0.02 -> "98 %". */
export function levelText(alpha: number): string {
  const pct = Math.round((1 - alpha) * 10000) / 100; // threshold-ok: percent with 2 places
  return `${pct} %`;
}

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.map((c) => `- ${c}`).join("\n");

/** Render the report. Throws on a verdict outside the three, a bad sha, or a private path. */
export function renderReport(r: ReportInput): string {
  assertVerdict(r.verdict);
  for (const l of r.looks) assertVerdict(l.verdict);
  if (!/^[0-9a-f]{64}$/.test(r.prereg.sha256)) throw new Error("sha256 must be 64 hex characters");
  const label = r.statistic.variantLabel ?? null;
  const level = r.result.alpha === null ? "no bound" : `${levelText(r.result.alpha)} lower bound`;

  const lines: string[] = [];
  lines.push(`# ${r.item} ${r.title}${label === null ? "" : ` (${label})`}`);
  lines.push(
    `Item: ${r.item} (ch. 22) · Lineage: ${r.lineage} · Market: ${r.market} · Status: ${r.verdict}`,
  );
  lines.push("");
  lines.push("## Hypothesis");
  lines.push(r.hypothesis);
  lines.push("");
  lines.push("## Pre-registration");
  lines.push(
    `File ${r.prereg.file} · sha256 ${r.prereg.sha256} · committed ${r.prereg.commit} on ${r.prereg.date}, before ${r.prereg.runnerCommit}`,
  );
  lines.push("");
  lines.push("## Data");
  lines.push(`Source: ${r.data.sourceClass}`);
  lines.push(`Window: ${r.data.window}`);
  lines.push(`Universe: ${r.data.universe}`);
  lines.push(`Known-time rules: ${r.data.knownTime}`);
  lines.push("Caveats:");
  lines.push(bullets(r.data.caveats));
  lines.push("");
  lines.push("## Split");
  lines.push(
    r.split.kind === "split"
      ? `Development ${r.split.development.from} to ${r.split.development.to} · holdout ${r.split.holdout.from} to ${r.split.holdout.to}`
      : `Full window, one look: ${r.split.reason}`,
  );
  lines.push("");
  lines.push("## n");
  lines.push(
    `${r.n.setups} setups · ${r.n.sessions} sessions · ${r.n.blocks} blocks · floor ${r.n.floorSetups} setups and ${r.n.floorBlocks} blocks, ${r.n.floorMet ? "met" : "not met"} (counted before any outcome was read)`,
  );
  lines.push("");
  lines.push("## Statistic");
  lines.push(r.statistic.definition);
  lines.push(`Cost profile: ${r.statistic.costProfile} · parcel: ${r.statistic.parcel}`);
  if (label !== null) lines.push(`Label on every figure here: ${label}`);
  lines.push(`Matched control: ${r.statistic.control}`);
  lines.push(`Haircut: ${r.statistic.haircut}`);
  lines.push("");
  lines.push("## Result");
  lines.push(`Unit: ${r.result.unit}`);
  lines.push("");
  lines.push(`| Window | Mean | ${level} | n |`);
  lines.push("|---|---|---|---|");
  for (const row of r.result.rows) {
    lines.push(`| ${row.window} | ${fmtNumber(row.mean)} | ${fmtNumber(row.lower)} | ${row.n} |`);
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push(`${r.verdict}: ${r.verdictReason}`);
  if (r.verdict === "INCONCLUSIVE") {
    lines.push(`Missing: ${r.missingData ?? "the data this test needs"}`);
    lines.push(`The look fires later: ${r.firesLater ?? "when the floor is met"}`);
  }
  lines.push("");
  lines.push("## Looks");
  if (r.looks.length === 0) {
    lines.push("No look has been taken.");
  } else {
    lines.push("| Lineage | Market | Date | sha | Verdict |");
    lines.push("|---|---|---|---|---|");
    for (const l of r.looks) {
      lines.push(
        `| ${l.lineage} | ${l.market} | ${l.date} | ${l.sha.slice(0, 12)} | ${l.verdict} |`,
      ); // threshold-ok: sha prefix
    }
  }
  lines.push(`Refusals: ${r.refusals.length === 0 ? "none" : r.refusals.join("; ")}`);
  lines.push("");
  lines.push("## Next");
  lines.push(r.next);
  lines.push("");
  const text = lines.join("\n");
  assertNoPrivateText(text);
  return text;
}
