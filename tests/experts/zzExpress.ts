// Synthetic format-2 seed for the M22 E4 tests (praxis-expert-seed/2): the ZZ seed of zzSeed.ts plus a licence check, call
// proposals and cluster expressions. Every name is ZZ, every URL is on example.test (D-521, SEC-110): nothing here comes
// from the private research.
import { type SeedFiles, type SeedRow, zzSeedFiles } from "./zzSeed";

export const V2_AT = "2030-02-10T00:00:00.000Z";
export const PREREG_TEXT = "ZZ pre-registration: enter when the field is low, hold five sessions.";

export type SeedFilesV2 = Omit<SeedFiles, "manifest.json"> & {
  "manifest.json": { format: string; market: string; created_at: string };
  "licence-check.json": { format: string; checked_at: string; results: SeedRow[] };
  "call-proposals.json": {
    format: string;
    market: string;
    created_at: string;
    proposals: SeedRow[];
  };
  "expressions.json": { expressions: SeedRow[] };
};

const RULE = { schema_version: 2, entry: { field: "rsi2", op: "<", value: 10 } };
const EXIT = { family: "F1", kind: "hold", sessions: 5 };

/** K-ZZ2 and K-ZZ3 expressed, K-ZZ4 and K-ZZ5 parked, K-ZZ1 (it has a family fit) not addressed. */
export function zzSeedV2(): SeedFilesV2 {
  const base = zzSeedFiles();
  return {
    ...base,
    "manifest.json": { ...base["manifest.json"], format: "praxis-expert-seed/2" },
    "licence-check.json": {
      format: "praxis-licence-check/1",
      checked_at: V2_AT,
      results: [
        {
          expert_id: "X-ZZ1",
          source_key: "origin:zz1.example.test",
          checked_at: V2_AT,
          terms_url: "https://zz1.example.test/terms",
          robots: "allows",
          summarisation: "yes",
          status: "enabled",
          note: null,
        },
        {
          expert_id: "X-ZZ2",
          source_key: "youtube:zz-handle-2",
          checked_at: V2_AT,
          terms_url: null,
          robots: "disallows",
          summarisation: "unknown",
          status: "no",
          note: "ZZ robots disallows",
        },
        {
          expert_id: "X-ZZ3",
          source_key: "origin:zz3.example.test",
          checked_at: V2_AT,
          terms_url: null,
          robots: "unreachable",
          summarisation: "unknown",
          status: "unchecked",
          note: null,
        },
      ],
    },
    "call-proposals.json": {
      format: "praxis-call-proposals/1",
      market: "AU",
      created_at: V2_AT,
      proposals: [
        {
          claim_id: "C-ZZ-019",
          state: "complete",
          code: "ZZA",
          direction: "long",
          call_d: "2030-02-04",
          horizon_sessions: 20,
          price_basis: "close",
          target_micro: null,
          stop_micro: null,
          missing: [],
          reason: "",
        },
        {
          claim_id: "C-ZZ-020",
          state: "incomplete",
          code: null,
          direction: "short",
          call_d: null,
          horizon_sessions: null,
          price_basis: "unspecified",
          target_micro: null,
          stop_micro: null,
          missing: ["code", "date", "horizon"],
          reason: "ZZ the summary names no code, date or horizon",
        },
      ],
    },
    "expressions.json": {
      expressions: [
        {
          cluster_id: "K-ZZ2",
          outcome: "expressed",
          rule: RULE,
          exit: EXIT,
          preregistration: PREREG_TEXT,
          reason: "ZZ low oscillator entry",
        },
        {
          cluster_id: "K-ZZ3",
          outcome: "expressed",
          rule: {
            schema_version: 2,
            entry: { ratio: { num: "volume_ratio", den: "rsi14", op: ">=", value: 0.1 } },
          },
          exit: { family: "F1", kind: "family", max_sessions: 60 },
          preregistration: "ZZ pre-registration two.",
          reason: "ZZ volume against oscillator",
        },
        {
          cluster_id: "K-ZZ4",
          outcome: "parked",
          park_reason: "overlay_only",
          reason: "ZZ a risk rule, not an entry",
        },
        {
          cluster_id: "K-ZZ5",
          outcome: "parked",
          park_reason: "not_testable",
          reason: "ZZ no stated rule",
        },
      ],
    },
  };
}
