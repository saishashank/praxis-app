// M23 night step "monitors" (docs/M23_design.md, D-1613, D-1614): the residual-risk monitors of CXA-010. Task M1 owns
// monitors 1 to 4 (D-1615 to D-1618); task M2 appends monitors 5 to 8 (D-1619 to D-1622) to `MONITORS` below and edits
// nothing else here. A monitor is a `MonitorDef` (src/lib/cortex/monitors/store.ts): the period due tonight, and a pure
// computation over stored rows. `runMonitors` writes one `residual_monitor` row per monitor, market and period (once; the
// row is append-only) and one plain-words Owner line (`app_log` warn) per alarm. The step reads and writes only
// `residual_monitor` and `app_log` (a static test pins it), runs per enabled market, writes nothing to a book, a rule, a
// ranking or a card, and never throws past `runResearchNight`, which logs a failure and goes on.
import { permissionDef } from "@/lib/cortex/monitors/permission";
import { promotionDef } from "@/lib/cortex/monitors/promotion";
import { slopeDef } from "@/lib/cortex/monitors/slope";
import { runMonitors, type MonitorDef } from "@/lib/cortex/monitors/store";
import { twoBasisDef } from "@/lib/cortex/monitors/twoBasis";
import type { ResearchStep } from "../night";

/** The monitors, in order. Task M2 adds 5 to 8 at the end. */
export const MONITORS: readonly MonitorDef[] = [promotionDef, permissionDef, slopeDef, twoBasisDef];

export const monitorsStep: ResearchStep = {
  name: "monitors",
  plain: "reading the background watches",
  async run(db, o) {
    await runMonitors(db, o, MONITORS);
  },
};
