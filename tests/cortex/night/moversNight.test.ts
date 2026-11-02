// @vitest-environment node
// The movers gap additions inside runNight (CR-MOV-A1, A2, A4; D-743, D-745, D-747): a night that
// carries the movers input and has nothing to say is byte-identical to one without it; an open negative
// halt watch, a known results date and a heavily shorted name stop an F4 entry at step 8 with the new
// sub-ids, a short-risk name is sized at half. Synthetic ZZ world only.
import { describe, expect, it } from "vitest";
import { nightOutputJson, runNight } from "@/lib/cortex/night";
import { DEFAULT_MOVERS_PARAMS } from "@/lib/cortex/moversParams";
import type { MoversNight } from "@/lib/cortex/moversNight";
import { CODES, nightInputs, nightView, nightWorld, SESSIONS } from "./zzNight";

const T = SESSIONS.length - 1;
const STATUS = { F1: "allowed", F4: "allowed" } as const;

const quiet: MoversNight = {
  params: DEFAULT_MOVERS_PARAMS,
  haltWatch: new Map(),
  knownDates: new Map(),
};

const f4Code = (out: ReturnType<typeof runNight>): string =>
  out.decisions.filter((d) => d.bookId === "E04")[0]!.code;

describe("runNight with the movers input", () => {
  const base = runNight(nightInputs(T, { status: STATUS }));

  it("a quiet movers input changes no byte of the night", () => {
    const withQuiet = runNight(nightInputs(T, { status: STATUS, movers: quiet }));
    expect(nightOutputJson(withQuiet)).toBe(nightOutputJson(base));
  });

  it("an open halt watch with a negative expectation stops the F4 entry at step 8 (sub-check 8f), not F1", () => {
    const code = f4Code(base);
    const out = runNight(
      nightInputs(T, {
        status: STATUS,
        movers: {
          ...quiet,
          haltWatch: new Map(
            CODES.map((c) => [
              c,
              {
                sinceD: SESSIONS[T - 1]!,
                status: "open" as const,
                reasonClass: "capital_raise" as const,
                expectedSign: -1 as const,
                resumeD: null,
              },
            ]),
          ),
        },
      }),
    );
    expect(out.decisions.filter((d) => d.bookId === "E04")).toHaveLength(0);
    const blocked = out.blocked.find(
      (b) => b.bookId === "E04" && b.code === code && b.arm === "live",
    );
    expect(blocked?.firstFail).toBe("G08_event_state");
    const g08 = blocked!.trace.find((x) => x.gateId === "G08_event_state")!;
    expect(g08).toMatchObject({ pass: false, value: "8f_halt_resume:open:capital_raise" });
    // the same code is still an F1 candidate: only the dip-buy families are kept out
    expect(out.decisions.filter((d) => d.bookId === "E01").length).toBe(
      base.decisions.filter((d) => d.bookId === "E01").length,
    );
  });

  it("a results date inside the pre-window stops the F4 entry (8g); the window itself only notes the pass", () => {
    const code = f4Code(base);
    const out = runNight(
      nightInputs(T, {
        status: STATUS,
        movers: { ...quiet, knownDates: new Map(CODES.map((c) => [c, [SESSIONS[T]!]])) }, // a known date today
      }),
    );
    const blocked = out.blocked.find(
      (b) => b.bookId === "E04" && b.code === code && b.arm === "live",
    );
    expect(blocked!.trace.find((x) => x.gateId === "G08_event_state")).toMatchObject({
      pass: false,
      value: "8g_known_date:in:0",
    });
  });

  describe("short risk (A4): a smaller parcel, a veto only when the key says so", () => {
    const code = f4Code(base);
    const shorted = nightView(
      nightWorld({
        shorts: new Map(CODES.map((c) => [c, [{ asOf: SESSIONS[T - 10]!, ppm: 60_000 }]])),
      }),
    );
    it("halves the F4 parcel by default", () => {
      const out = runNight(nightInputs(T, { status: STATUS, movers: quiet }, shorted));
      const d = out.decisions.find((x) => x.bookId === "E04" && x.code === code)!;
      expect(d.halfSize).toBe(true);
      const plain = runNight(nightInputs(T, { status: STATUS }, shorted));
      expect(plain.decisions.find((x) => x.bookId === "E04" && x.code === code)!.halfSize).toBe(
        false,
      );
    });

    it("vetoes the F4 entry at 8h when short_risk_f4_veto is on", () => {
      const out = runNight(
        nightInputs(
          T,
          {
            status: STATUS,
            movers: { ...quiet, params: { ...DEFAULT_MOVERS_PARAMS, shortRiskF4Veto: true } },
          },
          shorted,
        ),
      );
      const b = out.blocked.find((x) => x.bookId === "E04" && x.code === code && x.arm === "live");
      expect(b!.trace.find((x) => x.gateId === "G08_event_state")).toMatchObject({
        pass: false,
        value: "8h_short_risk:heavily_shorted",
      });
    });
  });
});
