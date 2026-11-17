// M23 night step "monitors" (docs/M23_design.md, D-1613, D-1614): the residual-risk monitors of CXA-010. Task M1 owns
// monitors 1 to 4 (D-1615 to D-1618); task M2 appended monitors 5 to 8 (D-1619 to D-1622) to `MONITORS` below.
// A monitor is a `MonitorDef` (src/lib/cortex/monitors/store.ts): the period due tonight, and a pure
// computation over stored rows. `runMonitors` writes one `residual_monitor` row per monitor, market and period (once; the
// row is append-only) and one plain-words Owner line (`app_log` warn) per alarm. The step reads and writes only
// `residual_monitor` and `app_log` (a static test pins it), runs per enabled market, writes nothing to a book, a rule, a
// ranking or a card, and never throws past `runResearchNight`, which logs a failure and goes on.
import { fillExclusionDef } from "@/lib/cortex/monitors/fillExclusion";
import { lensDef } from "@/lib/cortex/monitors/lens";
import { permissionDef } from "@/lib/cortex/monitors/permission";
import { promotionDef } from "@/lib/cortex/monitors/promotion";
import { regimeSplitDef } from "@/lib/cortex/monitors/regimeSplit";
import { slopeDef } from "@/lib/cortex/monitors/slope";
import { stallDef } from "@/lib/cortex/monitors/stall";
import { runMonitors, type MonitorDef } from "@/lib/cortex/monitors/store";
import { twoBasisDef } from "@/lib/cortex/monitors/twoBasis";
import type { ResearchStep } from "../night";

/** The eight monitors, in order (1 to 4: M1; 5 to 8: M2, D-1619 to D-1622). */
export const MONITORS: readonly MonitorDef[] = [
  promotionDef,
  permissionDef,
  slopeDef,
  twoBasisDef,
  regimeSplitDef,
  lensDef,
  stallDef,
  fillExclusionDef,
];

export const monitorsStep: ResearchStep = {
  name: "monitors",
  plain: "reading the background watches",
  async run(db, o) {
    await runMonitors(db, o, MONITORS);
  },
};
