// A replay snapshot of the synthetic ZZ night world (M15 P3; AT-50 replay, AT-56 pattern). The forty
// sessions, four U1 codes and flat ^AXJO of tests/cortex/night/zzNight.ts, written through the real
// snapshot builder (so the new tables, the provenance columns and the load path are exercised) and
// loaded into a `SnapshotWorld`. ZZ codes only (SEC-110); TypeScript, never CSV.
import { defaultAgentParams } from "@/lib/agents/params";
import { buildSnapshot, loadSnapshot } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import { CODES, SESSIONS, barsFor } from "../../cortex/night/zzNight";

export const FROM = SESSIONS[0]!;
export const TO = SESSIONS[SESSIONS.length - 1]!;
const MICRO = 1_000_000;

export type ReplayWorldOptions = {
  /** Add ZZB's 2-for-1 split with its provenance (D-321): notice-confirmed, or absent = legacy vendor row. */
  readonly provenance?: "notice" | "vendor" | "legacy" | "none";
  readonly withShort?: boolean;
  readonly withMacro?: boolean;
  /** Write the GSPC and VIX bars beside AXJO. */
  readonly withUsIndex?: boolean;
};

/** The snapshot inputs of the world (rows as the builder takes them). */
export function replayInputs(o: ReplayWorldOptions = {}) {
  const calendar = SESSIONS.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  const universe = CODES.flatMap((code) =>
    SESSIONS.map((d) => ({
      d,
      code,
      status: "active",
      tier: "U1",
      mcap_est: 1e8,
      adv: 5e5,
      halted: 0,
    })),
  );
  const bars = CODES.flatMap((code) =>
    barsFor(code).map((b) => ({
      code,
      d: b.d,
      o: Number(b.open) / MICRO,
      h: Number(b.high) / MICRO,
      l: Number(b.low) / MICRO,
      c: Number(b.close) / MICRO,
      volume: Number(b.volume),
    })),
  );
  const index = (code: string, base: number) =>
    SESSIONS.map((d) => ({
      index_code: code,
      d,
      o_micro: base * MICRO,
      h_micro: base * MICRO,
      l_micro: base * MICRO,
      c_micro: base * MICRO,
    }));
  const index_bars = [
    ...index("AXJO", 7_000),
    ...(o.withUsIndex === false ? [] : [...index("GSPC", 5_000), ...index("VIX", 15)]),
  ];
  const prov = o.provenance ?? "none";
  const corporate_actions =
    prov === "none"
      ? []
      : [
          {
            code: "ZZB",
            ex_date: SESSIONS[30]!,
            action_id: 1,
            type: "split",
            factor: 0.5,
            known_at: `${SESSIONS[20]!}T08:00:00.000Z`,
            ...(prov === "notice"
              ? { sources: "announcement,vendor", status: "confirmed" }
              : prov === "vendor"
                ? { sources: "vendor", status: "confirmed" }
                : {}),
          },
        ];
  const short_interest =
    o.withShort === true
      ? SESSIONS.slice(0, 30).map((d, i) => ({ code: "ZZA", as_of: d, ppm: 1_000 + 10 * i }))
      : [];
  const macro_series =
    o.withMacro === true
      ? SESSIONS.map((d, i) => ({ series: "ZZ_RATE", obs_d: d, value: 3 + i / 100 }))
      : [];
  return {
    calendar,
    universe,
    bars,
    index_bars,
    corporate_actions,
    announcements: [],
    short_interest,
    macro_series,
  };
}

export function replaySnapshotBytes(o: ReplayWorldOptions = {}) {
  return buildSnapshot({ from: FROM, to: TO, inputs: replayInputs(o) });
}

/** The loaded world (the replay's SnapshotWorld) of the synthetic night world. */
export function replayWorld(o: ReplayWorldOptions = {}): SnapshotWorld {
  const snap = loadSnapshot(replaySnapshotBytes(o).bytes);
  return new SnapshotWorld(snap, { params: defaultAgentParams() });
}
