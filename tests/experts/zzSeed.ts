// Synthetic expert seed for the M13-lite tests (format praxis-expert-seed/1). Every expert is a "ZZ ..."
// name and every URL is on example.test (D-521, SEC-110): nothing here comes from the private research.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type SeedFiles = {
  "manifest.json": { format: string; market: string; created_at: string };
  "experts.json": { experts: any[] };
  "items.json": { items: any[] };
  "claims.json": { claims: any[] };
  "clusters.json": { clusters: any[] };
  "calls.json"?: { calls: any[] };
};

const AT = "2030-02-01T00:00:00.000Z";

export function zzSeedFiles(): SeedFiles {
  const experts = Array.from({ length: 6 }, (_, i) => {
    const n = i + 1;
    return {
      id: `X-ZZ${n}`,
      name: `ZZ Expert ${n}`,
      platforms: n % 2 === 0 ? ["youtube", "own_site"] : ["own_site"],
      handles: { youtube: `zz-handle-${n}` },
      home_urls: [`https://zz${n}.example.test/home`],
      markets: ["AU"],
      focus: n <= 3 ? ["momentum"] : ["value"],
      status: n === 6 ? "retired" : "tracked",
      tier: "core",
      no_feed: n >= 5,
      ...(n === 1 ? { audience_size: 12000, audience_d: "2030-01-15" } : {}),
      ...(n === 2
        ? {
            red_flags: [
              {
                text: "ZZ synthetic caveat: results are the author's own sample.",
                source_url: "https://zz2.example.test/caveat",
                noted_d: "2030-01-20",
              },
            ],
          }
        : {}),
    };
  });
  const items = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      expert_id: `X-ZZ${(i % 6) + 1}`,
      url: `https://zz${(i % 6) + 1}.example.test/post-${n}`,
      platform: "own_site",
      title: null,
      published_at: null,
      content_hash: null,
      summary: n % 3 === 0 ? `ZZ synthetic note ${n}, our own words.` : null,
      quote: n === 1 ? "a short synthetic quote" : null,
      kind: n <= 10 ? "method" : "call",
      extraction_status: "seeded",
    };
  });
  const clusters = [
    cl(
      "K-ZZ1",
      "trend_momentum",
      "ZZ cluster one",
      "F1",
      { lookback: 126 },
      ["C-ZZ-001", "C-ZZ-002", "C-ZZ-003"],
      ["C-ZZ-004"],
    ),
    cl(
      "K-ZZ2",
      "mean_reversion",
      "ZZ cluster two",
      "F2",
      null,
      ["C-ZZ-005", "C-ZZ-006", "C-ZZ-007"],
      [],
    ),
    cl("K-ZZ3", "volume", "ZZ cluster three", "new", null, ["C-ZZ-008", "C-ZZ-009"], []),
    cl(
      "K-ZZ4",
      "macro",
      "ZZ cluster four",
      "overlay",
      null,
      ["C-ZZ-010", "C-ZZ-011"],
      ["C-ZZ-012"],
    ),
    cl("K-ZZ5", "none", "ZZ cluster five", null, null, ["C-ZZ-013", "C-ZZ-014", "C-ZZ-002"], []),
  ];
  const claims = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    const id = `C-ZZ-${String(n).padStart(3, "0")}`;
    const isCall = n >= 19;
    return {
      id,
      type: isCall ? "call" : n % 5 === 0 ? "risk_rule" : "method",
      testability: n % 4 === 0 ? "needs_new_data" : "testable_eod",
      statement: `ZZ synthetic claim ${n}.`,
      formalisation: n % 4 === 0 ? null : `ZZ draft rule ${n}.`,
      vocabulary_gap: n % 4 === 0 ? "ZZ missing input" : null,
      claimed_edge: n % 3 === 0 ? "ZZ claimed edge (as claimed)" : null,
      experts: n % 7 === 0 ? ["X-ZZ1", "X-ZZ2"] : [`X-ZZ${(i % 6) + 1}`],
      items: [items[i % 12]!.url],
      cluster_id: clusters.find((k) => k.supports.includes(id))?.id ?? null,
    };
  });
  return {
    "manifest.json": { format: "praxis-expert-seed/1", market: "AU", created_at: AT },
    "experts.json": { experts },
    "items.json": { items },
    "claims.json": { claims },
    "clusters.json": { clusters },
    "calls.json": {
      calls: [
        {
          claim_id: "C-ZZ-019",
          market: "AU",
          code: "ZZA",
          direction: "long",
          call_d: "2030-01-10",
          horizon_sessions: 20,
          target_micro: 12_000_000,
          stop_micro: 9_000_000,
          tracked: true,
        },
        {
          claim_id: "C-ZZ-020",
          market: "US",
          code: "ZZB",
          direction: "short",
          call_d: "2030-01-12",
          horizon_sessions: 60,
          target_micro: null,
          stop_micro: null,
          tracked: false,
        },
      ],
    },
  };
}

function cl(
  id: string,
  category: string,
  name: string,
  closest: string | null,
  params: Record<string, number> | null,
  supports: string[],
  contradicts: string[],
) {
  return {
    id,
    name,
    category,
    statement: `${name}: a synthetic statement.`,
    canonical_text: `${name}: synthetic canonical rule.`,
    testability: category === "none" ? "not_testable" : "testable_eod",
    external_grade: category === "macro" ? "mixed" : "not_searched",
    evidence_links:
      category === "macro"
        ? [{ url: "https://evidence.example.test/zz", note: "ZZ evidence" }]
        : [],
    vocabulary_gaps: category === "macro" ? 1 : 0,
    closest_family: closest,
    family_fit: params && closest ? { family: closest, params } : null,
    supports,
    contradicts,
  };
}

export function writeSeed(files: SeedFiles = zzSeedFiles()): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-seed-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
