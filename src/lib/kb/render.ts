// Deterministic markdown renderers for the knowledge-base documents (KB-001..003, EML-015; M6 T13,
// design 2.10). Every function is a pure function of plain records: no clock, no randomness, no
// database, no third-party text (KB-061: the renderers have no announcement input). The database is
// authoritative; these files are regenerated and never hand-edited (KB-001).
//
// Layout (KB-002): knowledge/{market}/families/F1.md, agent-playbooks/{agent}.md, lessons/L-{id}.md,
// challengers/C-{id}.md, reviews/YYYY-MM-DD.md, hypotheses/H-{id}.md, knowledge/common/*.md.
// Front matter (KB-003): id, market, type, created, updated, version, evidence grade (if any),
// related ids. Wording is never stronger than the grade (KB-020): L0 "was observed", L1 "may hold",
// L2 "held in a later test", L3 "was adopted".
import { createHash } from "node:crypto";
import type { DocumentType } from "@/lib/learning/schema";

export type DocFront = {
  readonly id: string;
  readonly market: string;
  readonly type: DocumentType;
  readonly created: string;
  readonly updated: string;
  readonly version: number;
  readonly grade: string | null;
  readonly related: readonly string[];
};

export type RenderedDoc = {
  readonly path: string;
  readonly front: Omit<DocFront, "version">;
  readonly body: string;
  /** Record ids this document renders, `<kind>:<key>`, sorted (the mapping-completeness check). */
  readonly sourceIds: readonly string[];
};

// ---------------------------------------------------------------------------------------------
// Basics

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const q = (s: string): string => JSON.stringify(s);

/** The KB-003 front matter block, fixed key order, JSON-quoted scalars (valid YAML). */
export function renderFrontMatter(f: DocFront): string {
  const lines = [
    "---",
    `id: ${q(f.id)}`,
    `market: ${q(f.market)}`,
    `type: ${q(f.type)}`,
    `created: ${q(f.created)}`,
    `updated: ${q(f.updated)}`,
    `version: ${f.version}`,
  ];
  if (f.grade !== null) lines.push(`grade: ${q(f.grade)}`);
  lines.push(`related: [${[...f.related].map(q).join(", ")}]`, "---", "");
  return `${lines.join("\n")}\n`;
}

/** The bytes of the archived file. */
export function renderFile(front: DocFront, body: string): string {
  return renderFrontMatter(front) + body;
}

/** Hash of everything but the version number: a new version exists only when this changes. */
export function contentSha(front: Omit<DocFront, "version">, body: string): string {
  return sha256(JSON.stringify([front, body]));
}

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** A number with at most 6 significant digits, no exponent noise; null / undefined → "n/a". */
export function num(x: number | string | bigint | null | undefined): string {
  if (x === null || x === undefined) return "n/a";
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "string") return esc(x);
  if (!Number.isFinite(x)) return "n/a";
  return String(Number(x.toPrecision(6)));
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "_None._\n";
  const line = (cells: readonly string[]) => `| ${cells.map(esc).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}

const list = (items: readonly string[]): string =>
  items.length === 0 ? "_None._\n" : items.map((i) => `- ${i}`).join("\n") + "\n";

const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const lower = (s: string): string => s.toLowerCase();

/** Verbs by grade: a statement is never stronger than its grade (KB-020). */
export const GRADE_VERB: Readonly<Record<string, string>> = {
  L0: "was observed",
  L1: "may hold",
  L2: "held in a later test",
  L3: "was adopted",
  retired: "was retired",
};

export function marketPath(market: string): string {
  return lower(market);
}

export const familyPath = (market: string, family: string): string =>
  `knowledge/${marketPath(market)}/families/${family}.md`;
export const playbookPath = (market: string, agent: string): string =>
  `knowledge/${marketPath(market)}/agent-playbooks/${agent}.md`;
export const lessonPath = (market: string, id: string): string =>
  `knowledge/${marketPath(market)}/lessons/${id}.md`;
export const challengerPath = (market: string, id: string): string =>
  `knowledge/${marketPath(market)}/challengers/${id}.md`;
export const reviewPath = (market: string, d: string): string =>
  `knowledge/${marketPath(market)}/reviews/${d}.md`;
export const hypothesisPath = (market: string, id: string): string =>
  `knowledge/${marketPath(market)}/hypotheses/${id}.md`;
export const SOURCE_REGISTER_PATH = "knowledge/common/source-register.md";

// ---------------------------------------------------------------------------------------------
// Families (KB-002, KB-010, KB-012, decision 39)

export type SleeveLegView = {
  readonly leverage: number | null;
  readonly sleeveTrades: number | string | null;
  readonly shadowTrades: number | string | null;
  readonly closeouts: number | string | null;
  readonly locks: number | string | null;
  readonly netPlMicro: number | string | null;
};

export type FamilyInput = {
  readonly market: string;
  readonly family: string;
  readonly created: string;
  readonly updated: string;
  readonly current: { readonly id: string; readonly origin: string; readonly label: string };
  readonly params: Readonly<Record<string, unknown>>;
  readonly bounds: Readonly<Record<string, readonly [number, number] | null>>;
  readonly versions: readonly {
    readonly id: string;
    readonly parent: string | null;
    readonly origin: string;
    readonly registeredD: string;
    readonly status: string;
  }[];
  readonly lessons: readonly { readonly id: string; readonly grade: string }[];
  readonly challengers: readonly { readonly id: string; readonly state: string }[];
  readonly sleeve: {
    readonly levered: SleeveLegView | null;
    readonly reality: SleeveLegView | null;
  } | null;
  readonly sourceIds: readonly string[];
};

function paramText(v: unknown): string {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean"
    ? num(typeof v === "boolean" ? String(v) : v)
    : JSON.stringify(v);
}

function sleeveRows(s: NonNullable<FamilyInput["sleeve"]>): string[][] {
  const rows: string[][] = [];
  for (const [name, leg] of [
    ["Levered", s.levered],
    ["Reality-adjusted", s.reality],
  ] as const) {
    if (leg === null) continue;
    rows.push([
      name,
      leg.leverage === null ? "n/a" : `${num(leg.leverage)}x`,
      num(leg.sleeveTrades),
      num(leg.shadowTrades),
      num(leg.closeouts),
      num(leg.locks),
      num(leg.netPlMicro),
    ]);
  }
  return rows;
}

export function renderFamily(i: FamilyInput): RenderedDoc {
  const keys = Object.keys(i.params).sort();
  const body = [
    `# ${i.family} (${i.market}) rule version ${i.current.id}`,
    "",
    `Origin: ${i.current.origin}. Label: ${i.current.label}.`,
    "",
    "## Parameters",
    "",
    table(
      ["Parameter", "Value", "Bounds"],
      keys.map((k) => {
        const b = i.bounds[k] ?? null;
        return [k, paramText(i.params[k]), b === null ? "n/a" : `${num(b[0])} to ${num(b[1])}`];
      }),
    ),
    "## Version history",
    "",
    table(
      ["Version", "Parent", "Origin", "Registered", "Status"],
      i.versions.map((v) => [v.id, v.parent ?? "none", v.origin, v.registeredD, v.status]),
    ),
    "## Hypothetical leverage",
    "",
    i.sleeve === null || sleeveRows(i.sleeve).length === 0
      ? "_No sleeve figures yet._\n"
      : "These are hypothetical leverage figures from the latest replay (a replay statistic, not a result of trading).\n\n" +
        table(
          [
            "Sleeve",
            "Leverage",
            "Sleeve trades",
            "Shadow trades",
            "Close-outs",
            "Locks",
            "Net P/L (micro)",
          ],
          sleeveRows(i.sleeve),
        ),
    "## Lessons",
    "",
    list(i.lessons.map((l) => `${l.id} (${l.grade})`)),
    "## Challengers",
    "",
    list(i.challengers.map((c) => `${c.id} (${c.state})`)),
  ].join("\n");
  return {
    path: familyPath(i.market, i.family),
    front: {
      id: `${i.market}-${i.family}`,
      market: i.market,
      type: "family",
      created: i.created,
      updated: i.updated,
      grade: null,
      related: sorted([
        ...i.versions.map((v) => v.id),
        ...i.lessons.map((l) => l.id),
        ...i.challengers.map((c) => c.id),
      ]),
    },
    body,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Playbooks (KB-002, KB-031, KB-032: the text is the stored template-assembled content)

export type PlaybookInput = {
  readonly market: string;
  readonly agent: string;
  readonly current: {
    readonly n: number;
    readonly content: string;
    readonly tokensEst: number;
    readonly effectiveD: string;
  };
  readonly history: readonly {
    readonly n: number;
    readonly effectiveD: string;
    readonly contentSha: string;
    readonly changeId: number;
  }[];
  readonly created: string;
  readonly updated: string;
  readonly sourceIds: readonly string[];
};

export function renderPlaybook(i: PlaybookInput): RenderedDoc {
  const body = [
    `# ${i.agent} playbook (${i.market}), version ${i.current.n}`,
    "",
    `Effective ${i.current.effectiveD}. About ${i.current.tokensEst} tokens.`,
    "",
    "## Content",
    "",
    i.current.content.replace(/\s+$/, ""),
    "",
    "## Version history",
    "",
    table(
      ["Version", "Effective", "Content sha", "Change"],
      i.history.map((h) => [
        String(h.n),
        h.effectiveD,
        h.contentSha.slice(0, 12),
        String(h.changeId),
      ]),
    ),
  ].join("\n");
  return {
    path: playbookPath(i.market, i.agent),
    front: {
      id: `${i.market}-playbook-${i.agent}`,
      market: i.market,
      type: "playbook",
      created: i.created,
      updated: i.updated,
      grade: null,
      related: sorted(i.history.map((h) => `change-${h.changeId}`)),
    },
    body,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Lessons (ARN-063, KB-020)

export type GradeView = {
  readonly seq: number;
  readonly grade: string;
  readonly window: string | null;
  readonly n: number;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly p: number | null;
  readonly d: string;
  readonly corrects: number | null;
};

export type ChangeView = {
  readonly id: number;
  readonly kind: string;
  readonly target: string;
  readonly effectiveD: string;
  readonly actor: string;
};

export type CritiqueView = {
  readonly subjectId: string;
  readonly runId: string;
  readonly passed: boolean;
  readonly d: string;
};

export type LessonInput = {
  readonly market: string;
  readonly id: string;
  readonly templateId: string;
  readonly metric: string;
  readonly direction: number;
  readonly subjectText: string;
  readonly ruleVersion: string;
  readonly lineageId: string | null;
  readonly paramHint: string | null;
  readonly createdD: string;
  readonly grades: readonly GradeView[];
  readonly critiques: readonly CritiqueView[];
  readonly changes: readonly ChangeView[];
  readonly plan: readonly {
    readonly d: string;
    readonly rank: number;
    readonly lane: string;
    readonly kind: string;
  }[];
  readonly updated: string;
  readonly sourceIds: readonly string[];
};

export function statementOf(
  i: Pick<LessonInput, "templateId" | "metric" | "direction" | "subjectText">,
  grade: string,
): string {
  const dir = i.direction > 0 ? "higher" : "lower";
  const verb = GRADE_VERB[grade] ?? GRADE_VERB.L0;
  return `The pattern "${i.templateId}" for ${i.subjectText}, with ${i.metric} ${dir} than the baseline, ${verb}.`;
}

export function renderLesson(i: LessonInput): RenderedDoc {
  const last = i.grades.length === 0 ? null : i.grades[i.grades.length - 1];
  const grade = last === null ? "L0" : last.grade;
  const body = [
    `# Lesson ${i.id}`,
    "",
    `Grade: ${grade}. Rule version: ${i.ruleVersion}.${i.lineageId === null ? "" : ` Lineage: ${i.lineageId}.`}`,
    "",
    "## Statement",
    "",
    statementOf(i, grade),
    "",
    ...(i.paramHint === null ? [] : [`Parameter hint (not applied): ${i.paramHint}.`, ""]),
    "## Grade history",
    "",
    table(
      ["Seq", "Grade", "Window", "n", "Estimate", "Lower", "Upper", "p", "Date", "Corrects"],
      i.grades.map((g) => [
        String(g.seq),
        g.grade,
        g.window ?? "n/a",
        String(g.n),
        num(g.estimate),
        num(g.lower),
        num(g.upper),
        num(g.p),
        g.d,
        g.corrects === null ? "none" : String(g.corrects),
      ]),
    ),
    "## Critic",
    "",
    table(
      ["Run", "Result", "Date"],
      i.critiques.map((c) => [c.runId, c.passed ? "passed" : "not passed", c.d]),
    ),
    "## Changes",
    "",
    table(
      ["Change", "Kind", "Target", "Effective", "Actor"],
      i.changes.map((c) => [String(c.id), c.kind, c.target, c.effectiveD, c.actor]),
    ),
    "## Plan items",
    "",
    table(
      ["Date", "Rank", "Lane", "Kind"],
      i.plan.map((p) => [p.d, String(p.rank), p.lane, p.kind]),
    ),
  ].join("\n");
  return {
    path: lessonPath(i.market, i.id),
    front: {
      id: i.id,
      market: i.market,
      type: "lesson",
      created: i.createdD,
      updated: i.updated,
      grade,
      related: sorted([
        i.ruleVersion,
        ...(i.lineageId === null ? [] : [i.lineageId]),
        ...i.changes.map((c) => `change-${c.id}`),
      ]),
    },
    body,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Challengers (KB-040)

export type ChallengerInput = {
  readonly market: string;
  readonly id: string;
  readonly lineageId: string;
  readonly state: string;
  readonly ruleVersionId: string;
  readonly incumbentVersionId: string;
  readonly origin: string;
  readonly lessonIds: readonly string[];
  readonly paramDiff: readonly {
    readonly key: string;
    readonly incumbent: string;
    readonly challenger: string;
  }[];
  readonly events: readonly {
    readonly seq: number;
    readonly from: string | null;
    readonly to: string;
    readonly d: string;
    readonly actor: string;
    readonly reason: string;
  }[];
  readonly critiques: readonly CritiqueView[];
  readonly changes: readonly ChangeView[];
  readonly created: string;
  readonly updated: string;
  readonly sourceIds: readonly string[];
};

export function renderChallenger(i: ChallengerInput): RenderedDoc {
  const body = [
    `# Challenger ${i.id}`,
    "",
    `State: ${i.state}. Origin: ${i.origin}. Lineage: ${i.lineageId}.`,
    `Challenger version ${i.ruleVersionId} against incumbent ${i.incumbentVersionId}.`,
    "",
    "## Parameter changes",
    "",
    table(
      ["Parameter", "Incumbent", "Challenger"],
      i.paramDiff.map((p) => [p.key, p.incumbent, p.challenger]),
    ),
    "## Lessons behind it",
    "",
    list(i.lessonIds),
    "## State history",
    "",
    table(
      ["Seq", "From", "To", "Date", "Actor", "Reason"],
      i.events.map((e) => [String(e.seq), e.from ?? "none", e.to, e.d, e.actor, e.reason]),
    ),
    "## Critic",
    "",
    table(
      ["Run", "Result", "Date"],
      i.critiques.map((c) => [c.runId, c.passed ? "passed" : "not passed", c.d]),
    ),
    "## Changes",
    "",
    table(
      ["Change", "Kind", "Target", "Effective", "Actor"],
      i.changes.map((c) => [String(c.id), c.kind, c.target, c.effectiveD, c.actor]),
    ),
  ].join("\n");
  return {
    path: challengerPath(i.market, i.id),
    front: {
      id: i.id,
      market: i.market,
      type: "challenger",
      created: i.created,
      updated: i.updated,
      grade: null,
      related: sorted([i.ruleVersionId, i.incumbentVersionId, i.lineageId, ...i.lessonIds]),
    },
    body,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Reviews (EML-015: the stored Evening Review markdown of that date, one file per date)

export type ReviewInput = {
  readonly market: string;
  readonly d: string;
  readonly version: number;
  readonly kind: string;
  readonly markdown: string;
  readonly plan: readonly {
    readonly rank: number;
    readonly lane: string;
    readonly kind: string;
    readonly reason: string;
  }[];
  readonly sourceIds: readonly string[];
};

export function renderReview(i: ReviewInput): RenderedDoc {
  const planPart =
    i.plan.length === 0
      ? []
      : [
          "",
          "## Learning plan of the night",
          "",
          table(
            ["Rank", "Lane", "Kind", "Reason"],
            i.plan.map((p) => [String(p.rank), p.lane, p.kind, p.reason]),
          ),
        ];
  const body = [i.markdown.replace(/\s+$/, ""), ...planPart].join("\n") + "\n";
  return {
    path: reviewPath(i.market, i.d),
    front: {
      id: `${i.market}-review-${i.d}`,
      market: i.market,
      type: "review",
      created: i.d,
      updated: i.d,
      grade: null,
      related: [`review-version-${i.version}`, `review-kind-${i.kind}`],
    },
    body,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Hypotheses (Owner or A6 notes; no table in M6, so no document is produced from records)

export type HypothesisInput = {
  readonly market: string;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly created: string;
  readonly updated: string;
  readonly related: readonly string[];
  readonly sourceIds: readonly string[];
};

export function renderHypothesis(i: HypothesisInput): RenderedDoc {
  return {
    path: hypothesisPath(i.market, i.id),
    front: {
      id: i.id,
      market: i.market,
      type: "hypothesis",
      created: i.created,
      updated: i.updated,
      grade: null,
      related: sorted(i.related),
    },
    body: `# ${i.title}\n\n${i.text.replace(/\s+$/, "")}\n`,
    sourceIds: sorted(i.sourceIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Source register (knowledge/common, decision 31: the register export; no owner references)

export type SourceRegisterInput = {
  readonly sources: readonly {
    readonly source: string;
    readonly risk: string;
    readonly status: string;
    readonly permittedUse: string | null;
    readonly rateLimits: string | null;
    readonly lastChecked: string | null;
    readonly summarisationPermitted: boolean;
    readonly termsUrl: string | null;
  }[];
  readonly created: string;
  readonly updated: string;
};

export function renderSourceRegister(i: SourceRegisterInput): RenderedDoc {
  const rows = [...i.sources].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
  const body = [
    "# Source register",
    "",
    table(
      [
        "Source",
        "Risk",
        "Status",
        "Permitted use",
        "Rate limits",
        "Last checked",
        "Summarisation",
        "Terms",
      ],
      rows.map((s) => [
        s.source,
        s.risk,
        s.status,
        s.permittedUse ?? "n/a",
        s.rateLimits ?? "n/a",
        s.lastChecked ?? "n/a",
        s.summarisationPermitted ? "permitted" : "not permitted",
        s.termsUrl ?? "n/a",
      ]),
    ),
  ].join("\n");
  return {
    path: SOURCE_REGISTER_PATH,
    front: {
      id: "common-source-register",
      market: "common",
      type: "source_register",
      created: i.created,
      updated: i.updated,
      grade: null,
      related: [],
    },
    body,
    sourceIds: sorted(rows.map((s) => `source_register:${s.source}`)),
  };
}
