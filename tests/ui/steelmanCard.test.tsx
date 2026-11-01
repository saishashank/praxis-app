// @vitest-environment node
// Steelman section of the Decision Card (M11-lite WP6; D-497/D-498): two lists, evidence chips, the
// cited rows, caption, collapsed <details> on phones, the "not available" state, wording and masking.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Steelman } from "@/app/(app)/cards/[id]/Steelman";
import { CARD_BANNED } from "@/lib/cortex/phrases";
import { readSteelmanForCard, type SteelmanView } from "@/lib/steelman/read";
import { loadCardPage, cardRef } from "@/lib/ui/loaders/cards";
import { cleanupTempDbs } from "../db/helpers";
import {
  CARD_UP,
  EDITOR,
  emptyDbs,
  NOW,
  OWNER,
  seedPopulated,
  VIEWER,
  type Both,
} from "../loaders/seed";
import { seedSteelman } from "../steelman/uiSeed";

let db: Both;
beforeAll(async () => {
  db = await emptyDbs();
  await seedPopulated(db);
  await seedSteelman(db.main);
});
afterAll(cleanupTempDbs);

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const load = (user: { id: number; role: string }, id: string) =>
  loadCardPage({ mainDb: db.main, authDb: db.auth, user, now: NOW }, id);

describe("Steelman component", () => {
  it("renders nothing for null and for a written view with no points", () => {
    expect(renderToStaticMarkup(<Steelman data={null} />)).toBe("");
    const none: SteelmanView = { state: "written", bull: [], bear: [], cited: [] };
    expect(renderToStaticMarkup(<Steelman data={none} />)).toBe("");
  });

  it("draws two lists, chips to #ev-<id>, the cited rows with those ids and the caption", async () => {
    const v = (await readSteelmanForCard(db.main, CARD_UP))!;
    expect(v.state).toBe("written");
    expect(v.bull).toHaveLength(2);
    expect(v.bear).toHaveLength(2); // the critic-hidden point is not shown
    expect(v.cited.map((c) => c.id)).toEqual(["E02", "E03"]);
    const html = renderToStaticMarkup(<Steelman data={v} />);
    expect(html).toContain(">Strongest case for</h3>");
    expect(html).toContain(">Strongest case against</h3>");
    expect(html).toContain('href="#ev-E02"');
    expect(html).toContain('id="ev-E02"');
    expect(html).toContain(">Evidence cited</h3>");
    expect(html).toContain(
      "AI-written from the evidence on this card. Not advice; not a forecast.",
    );
    expect(html).not.toContain("Hidden by the checker");
  });

  it("keeps the body under 640 px in a collapsed <details> with its own anchors", async () => {
    const v = (await readSteelmanForCard(db.main, CARD_UP))!;
    const html = renderToStaticMarkup(<Steelman data={v} />);
    expect(html).toMatch(/<details class="sm:hidden"(?! open)/);
    expect(html).toContain('class="hidden sm:block"');
    expect(html).toContain('href="#m-ev-E02"');
    expect(html).toContain('id="m-ev-E02"');
  });

  it("says 'not available tonight' with the reason in plain words", () => {
    const v: SteelmanView = {
      state: "not_written",
      reason: "no_model",
      bull: [],
      bear: [],
      cited: [],
    };
    const t = text(renderToStaticMarkup(<Steelman data={v} />));
    expect(t).toContain("Not available tonight: no model was available.");
    const bare = text(renderToStaticMarkup(<Steelman data={{ ...v, reason: undefined }} />));
    expect(bare).toContain("Not available tonight.");
  });

  it("never says certain, guaranteed or will, and no banned card wording", async () => {
    const v = (await readSteelmanForCard(db.main, CARD_UP))!;
    const all = [
      text(renderToStaticMarkup(<Steelman data={v} />)),
      text(
        renderToStaticMarkup(
          <Steelman
            data={{ state: "not_written", reason: "budget", bull: [], bear: [], cited: [] }}
          />,
        ),
      ),
    ].join(" ");
    expect(all).not.toMatch(/\b(certain|certainly|guaranteed|will)\b/i);
    for (const b of CARD_BANNED) expect(all).not.toMatch(b);
  });
});

describe("card loader", () => {
  it("gives the Owner the real text", async () => {
    const r = await load(OWNER, CARD_UP);
    const s = r.data.steelman!;
    expect(s.bull[0]!.text).toContain("Zed Upward Holdings");
    expect(s.cited[0]!.text).toContain("Zed Upward Holdings");
  });

  it("masks every point and cited item for a masked viewer (ROL-107)", async () => {
    for (const who of [EDITOR, VIEWER]) {
      const r = await load(who, cardRef(CARD_UP));
      expect(r.masked).toBe(true);
      const s = r.data.steelman!;
      expect(s).not.toBeNull();
      const blob = JSON.stringify(s);
      expect(blob).not.toMatch(/ZZUP|Zed Upward/);
      expect(blob).not.toContain("2026-10-19");
      expect(s.cited.map((c) => c.id)).toEqual(["E02", "E03"]); // ids stay
    }
  });

  it("is null when nothing is stored", async () => {
    const r = await load(OWNER, (await import("../loaders/seed")).CARD_DN);
    expect(r.data.steelman).toBeNull();
  });
});
